#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const argv = process.argv.slice(2);

function usage(exitCode = 1) {
  const text = [
    'Usage:',
    '  node "$SKILL_DIR/scripts/extract-session-state.mjs" <session-id> [--markdown|--json]',
    '',
    'Options:',
    '  --codex-home <path>        Codex data root. Default: ~/.codex',
    '  --max-snippet-chars <n>    Max characters per snippet. Default: 1800',
    '  --max-items <n>            Max items per section. Default: 30',
    '  --include-noise           Include AGENTS/environment user messages.',
    '',
    'This script only reads Codex session JSONL files. It does not read project files mentioned inside sessions.',
  ].join('\n');
  console.error(text);
  process.exit(exitCode);
}

function takeOption(name, fallback) {
  const index = argv.indexOf(name);
  if (index === -1) return fallback;
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) usage(1);
  argv.splice(index, 2);
  return value;
}

const outputJson = argv.includes('--json');
const outputMarkdown = argv.includes('--markdown') || !outputJson;
const includeNoise = argv.includes('--include-noise');
for (const flag of ['--json', '--markdown', '--include-noise']) {
  const index = argv.indexOf(flag);
  if (index !== -1) argv.splice(index, 1);
}

const codexHome = path.resolve(takeOption('--codex-home', path.join(os.homedir(), '.codex')));
const maxSnippetChars = Number(takeOption('--max-snippet-chars', '1800'));
const maxItems = Number(takeOption('--max-items', '30'));
const rootSessionId = argv[0];

if (!rootSessionId) usage(1);
if (!Number.isFinite(maxSnippetChars) || maxSnippetChars < 200) {
  throw new Error('--max-snippet-chars must be a number >= 200');
}
if (!Number.isFinite(maxItems) || maxItems < 1) {
  throw new Error('--max-items must be a number >= 1');
}

const searchRoots = [
  path.join(codexHome, 'sessions'),
  path.join(codexHome, 'archived_sessions'),
].filter((item) => fs.existsSync(item));

function walkFiles(root, visitor) {
  if (!fs.existsSync(root)) return;
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        visitor(full);
      }
    }
  }
}

function findSessionFilesById(sessionId) {
  const files = [];
  for (const root of searchRoots) {
    walkFiles(root, (file) => {
      if (file.endsWith('.jsonl') && path.basename(file).includes(sessionId)) {
        files.push(file);
      }
    });
  }
  return files.sort();
}

function snippet(value, limit = maxSnippetChars) {
  const text = String(value ?? '').replace(/\r/g, '').trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)} ...[truncated]`;
}

function parseJsonMaybe(text, fallback = {}) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function contentText(payload) {
  return (payload.content ?? []).map((item) => item.text ?? '').join('\n');
}

function isNoiseUserMessage(text) {
  return text.includes('# AGENTS.md instructions') || text.includes('<environment_context>');
}

function extractSubagentNotifications(text) {
  const results = [];
  const pattern = /<subagent_notification>\s*([\s\S]*?)\s*<\/subagent_notification>/g;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const parsed = parseJsonMaybe(match[1], null);
    if (parsed?.agent_path) {
      results.push({
        agent_id: parsed.agent_path,
        completed: parsed.status?.completed ?? null,
        raw: snippet(match[1]),
      });
    }
  }
  return results;
}

function parseSessionFile(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const lines = raw.trimEnd() ? raw.trimEnd().split(/\n/) : [];
  const calls = new Map();
  const session = {
    file,
    line_count: lines.length,
    meta: null,
    turn_contexts: [],
    user_messages: [],
    assistant_messages: [],
    final_answers: [],
    task_complete: null,
    spawn_attempts: [],
    send_inputs: [],
    close_agents: [],
    subagent_notifications: [],
    tool_failures: [],
    evidence_outputs: [],
    child_ids: [],
  };

  for (let index = 0; index < lines.length; index += 1) {
    let event;
    try {
      event = JSON.parse(lines[index]);
    } catch (error) {
      session.tool_failures.push({
        line: index + 1,
        kind: 'json_parse',
        text: error.message,
      });
      continue;
    }

    const payload = event.payload ?? {};
    const line = index + 1;

    if (event.type === 'session_meta') {
      session.meta = {
        line,
        timestamp: payload.timestamp ?? event.timestamp,
        id: payload.id,
        cwd: payload.cwd,
        originator: payload.originator,
        source: payload.source,
      };
      continue;
    }

    if (event.type === 'turn_context') {
      session.turn_contexts.push({
        line,
        turn_id: payload.turn_id,
        cwd: payload.cwd,
        current_date: payload.current_date,
        timezone: payload.timezone,
      });
      continue;
    }

    if (event.type === 'event_msg') {
      if (payload.type === 'agent_message') {
        const item = {
          line,
          timestamp: event.timestamp,
          phase: payload.phase,
          text: snippet(payload.message),
          event_msg: true,
        };
        session.assistant_messages.push(item);
        if (payload.phase === 'final_answer') session.final_answers.push(item);
      }
      if (payload.type === 'task_complete') {
        session.task_complete = {
          line,
          timestamp: event.timestamp,
          turn_id: payload.turn_id,
          completed_at: payload.completed_at,
          duration_ms: payload.duration_ms,
          last_agent_message: snippet(payload.last_agent_message, maxSnippetChars * 2),
        };
      }
      continue;
    }

    if (event.type !== 'response_item') continue;

    if (payload.type === 'message') {
      const text = contentText(payload);
      if (payload.role === 'user') {
        const notifications = extractSubagentNotifications(text);
        if (notifications.length) {
          session.subagent_notifications.push(...notifications.map((item) => ({
            ...item,
            line,
            timestamp: event.timestamp,
          })));
          for (const item of notifications) session.child_ids.push(item.agent_id);
        }
        if (includeNoise || !isNoiseUserMessage(text)) {
          session.user_messages.push({
            line,
            timestamp: event.timestamp,
            text: snippet(text),
          });
        }
      } else if (payload.role === 'assistant') {
        const item = {
          line,
          timestamp: event.timestamp,
          phase: payload.phase,
          text: snippet(text),
        };
        session.assistant_messages.push(item);
        if (payload.phase === 'final_answer') session.final_answers.push(item);
      }
      continue;
    }

    if (payload.type === 'function_call') {
      const args = parseJsonMaybe(payload.arguments ?? '{}', {});
      calls.set(payload.call_id, {
        line,
        timestamp: event.timestamp,
        name: payload.name,
        namespace: payload.namespace,
        args,
      });

      if (payload.name === 'send_input') {
        session.send_inputs.push({
          line,
          timestamp: event.timestamp,
          target: args.target,
          message: snippet(args.message),
        });
        if (args.target) session.child_ids.push(args.target);
      } else if (payload.name === 'close_agent') {
        session.close_agents.push({
          line,
          timestamp: event.timestamp,
          target: args.target,
        });
      }
      continue;
    }

    if (payload.type === 'function_call_output') {
      const call = calls.get(payload.call_id) ?? {};
      const output = String(payload.output ?? '');

      if (call.name === 'spawn_agent') {
        const parsed = parseJsonMaybe(output, null);
        const item = {
          line,
          timestamp: event.timestamp,
          call_line: call.line,
          ok: Boolean(parsed?.agent_id),
          agent_id: parsed?.agent_id,
          nickname: parsed?.nickname,
          output: snippet(output),
        };
        session.spawn_attempts.push(item);
        if (item.agent_id) session.child_ids.push(item.agent_id);
      }

      const failed =
        /Process exited with code [1-9]/.test(output) ||
        /Error:|Exception|Fatal|失败|报错|collab spawn failed/i.test(output);
      if (failed) {
        session.tool_failures.push({
          line,
          timestamp: event.timestamp,
          call_line: call.line,
          name: call.name,
          namespace: call.namespace,
          command: snippet(call.args?.cmd, 500),
          output: snippet(output),
        });
      }

      const evidenceText = `${call.args?.cmd ?? ''}\n${output}`;
      const interesting =
        /code=200|task_complete|final_answer|uploaded|UPLOAD|通过|success|SUCCESS|affected|Rows|GetTree|GetInstallRouter|GetAll|测试|验证|分销|refund|withdraw|wallet|commission|order|menu/i.test(evidenceText);
      if (interesting) {
        session.evidence_outputs.push({
          line,
          timestamp: event.timestamp,
          call_line: call.line,
          name: call.name,
          namespace: call.namespace,
          command: snippet(call.args?.cmd, 500),
          output: snippet(output),
        });
      }
    }
  }

  session.child_ids = [...new Set(session.child_ids)].filter(Boolean);
  return session;
}

function collectSessionTree(rootId) {
  const queue = [rootId];
  const seenIds = new Set();
  const sessions = [];
  const missing = [];

  while (queue.length) {
    const id = queue.shift();
    if (!id || seenIds.has(id)) continue;
    seenIds.add(id);

    const files = findSessionFilesById(id);
    if (!files.length) {
      missing.push(id);
      continue;
    }

    for (const file of files) {
      const session = parseSessionFile(file);
      sessions.push(session);
      for (const child of session.child_ids) {
        if (!seenIds.has(child)) queue.push(child);
      }
    }
  }

  return { sessions, missing };
}

function tail(items, count = maxItems) {
  return items.slice(Math.max(0, items.length - count));
}

function compactSession(session) {
  return {
    file: session.file,
    line_count: session.line_count,
    meta: session.meta,
    turn_count: session.turn_contexts.length,
    user_messages: tail(session.user_messages),
    final_answers: tail(session.final_answers),
    task_complete: session.task_complete,
    spawn_attempts: session.spawn_attempts,
    subagent_notifications: tail(session.subagent_notifications),
    close_agents: session.close_agents,
    tool_failures: tail(session.tool_failures),
    evidence_outputs: tail(session.evidence_outputs),
  };
}

function renderMarkdown(report) {
  const lines = [];
  lines.push(`# Session Extraction: ${report.root_session_id}`);
  lines.push('');
  lines.push('This is mechanical evidence extracted from Codex JSONL session files. Summarize the final state from the evidence; do not treat this script as current project verification.');
  lines.push('');
  lines.push('## Search');
  lines.push(`- Codex home: \`${report.codex_home}\``);
  lines.push(`- Search roots: ${report.search_roots.map((item) => `\`${item}\``).join(', ') || '(none)'}`);
  if (report.missing_session_ids.length) {
    lines.push(`- Missing session ids: ${report.missing_session_ids.map((item) => `\`${item}\``).join(', ')}`);
  }
  lines.push('');

  lines.push('## Sessions');
  for (const session of report.sessions) {
    const title = session.meta?.id ?? path.basename(session.file);
    lines.push(`### ${title}`);
    lines.push(`- File: \`${session.file}\``);
    lines.push(`- Lines: ${session.line_count}`);
    if (session.meta?.cwd) lines.push(`- CWD: \`${session.meta.cwd}\``);
    if (session.meta?.timestamp) lines.push(`- Started: ${session.meta.timestamp}`);
    if (session.turn_count) lines.push(`- Turns: ${session.turn_count}`);
    if (session.spawn_attempts.length) {
      lines.push('- Spawn attempts:');
      for (const attempt of session.spawn_attempts) {
        if (attempt.ok) {
          lines.push(`  - line ${attempt.line}: \`${attempt.agent_id}\`${attempt.nickname ? ` (${attempt.nickname})` : ''}`);
        } else {
          lines.push(`  - line ${attempt.line}: failed or rejected: ${attempt.output}`);
        }
      }
    }
    if (session.close_agents.length) {
      lines.push(`- Closed agents: ${session.close_agents.map((item) => `\`${item.target}\``).join(', ')}`);
    }
    lines.push('');

    if (session.user_messages.length) {
      lines.push('#### User Messages');
      for (const item of session.user_messages) {
        lines.push(`- line ${item.line}, ${item.timestamp}`);
        lines.push('');
        lines.push('```text');
        lines.push(item.text);
        lines.push('```');
      }
      lines.push('');
    }

    if (session.final_answers.length || session.task_complete) {
      lines.push('#### Final / Task Complete');
      for (const item of session.final_answers) {
        lines.push(`- final line ${item.line}, ${item.timestamp}`);
        lines.push('');
        lines.push('```text');
        lines.push(item.text);
        lines.push('```');
      }
      if (session.task_complete) {
        lines.push(`- task_complete line ${session.task_complete.line}, ${session.task_complete.timestamp}`);
        lines.push('');
        lines.push('```text');
        lines.push(session.task_complete.last_agent_message);
        lines.push('```');
      }
      lines.push('');
    }

    if (session.subagent_notifications.length) {
      lines.push('#### Subagent Notifications');
      for (const item of session.subagent_notifications) {
        lines.push(`- line ${item.line}, agent \`${item.agent_id}\``);
        lines.push('');
        lines.push('```text');
        lines.push(snippet(item.completed, maxSnippetChars));
        lines.push('```');
      }
      lines.push('');
    }

    if (session.tool_failures.length) {
      lines.push('#### Tool Failures / Rejected Calls');
      for (const item of session.tool_failures) {
        lines.push(`- line ${item.line}, ${item.name ?? item.kind ?? 'unknown'}`);
        if (item.command) lines.push(`  - command: \`${item.command}\``);
        lines.push('');
        lines.push('```text');
        lines.push(item.output ?? item.text);
        lines.push('```');
      }
      lines.push('');
    }

    if (session.evidence_outputs.length) {
      lines.push('#### Evidence Outputs');
      for (const item of session.evidence_outputs) {
        lines.push(`- line ${item.line}, ${item.name ?? 'tool'}`);
        if (item.command) lines.push(`  - command: \`${item.command}\``);
        lines.push('');
        lines.push('```text');
        lines.push(item.output);
        lines.push('```');
      }
      lines.push('');
    }
  }

  return `${lines.join('\n')}\n`;
}

const tree = collectSessionTree(rootSessionId);
if (!tree.sessions.length) {
  console.error(`No Codex session JSONL file found for session id: ${rootSessionId}`);
  console.error(`Searched: ${searchRoots.join(', ') || '(no roots)'}`);
  process.exit(2);
}

const report = {
  root_session_id: rootSessionId,
  codex_home: codexHome,
  search_roots: searchRoots,
  missing_session_ids: tree.missing,
  sessions: tree.sessions.map(compactSession),
};

if (outputJson) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else if (outputMarkdown) {
  process.stdout.write(renderMarkdown(report));
}
