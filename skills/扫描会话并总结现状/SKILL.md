# 扫描会话并总结现状

根据用户提供的会话 id，找到当前运行环境规定的会话文件，从主会话到子 agent 会话完整读取，并总结该会话中 agent 工作的最终/最新状态。

## 硬性边界
- 本SKILL 可直接用于 Codex 环境中，如果你当前不处于 Codex 环境中，你需读本SKILL所有内容后，需根据原理进化出专属你所在环境的版本
- 用户没有提供会话 id 时，必须立刻停止并索要；不允许私自猜测。
- 只读取会话存储文件和子 agent 会话文件。
- 不要读取该会话中实际操作过的项目、代码、数据库、远程服务或文件内容。
- 不要把会话记录里的验证结果当成“当前实时状态”；只能表述为“会话中记录为已通过/已完成/已失败”。
- 如果主会话创建了子 agent，必须读取所有能定位到的子 agent 会话文件；找不到的子 agent 要在总结中说明“未找到对应会话文件，只能依据主会话通知”。

## 推荐脚本

先把当前 `SKILL.md` 所在目录记为 `SKILL_DIR`。本 skill 自带脚本、资料和后续相对路径，都必须从 `SKILL_DIR` 解析，不允许从项目根目录或某个固定 `.jarvis` 目录解析。

优先使用本 skill 自带脚本做机械提取：

```bash
node "$SKILL_DIR/scripts/extract-session-state.mjs" <会话id> --markdown
```

需要给其他工具消费时使用 JSON：

```bash
node "$SKILL_DIR/scripts/extract-session-state.mjs" <会话id> --json
```

脚本只读取 Codex 会话 JSONL，默认搜索：

- `~/.codex/sessions`
- `~/.codex/archived_sessions`

脚本会：

- 按会话 id 定位主会话文件。
- 解析 `session_meta`、用户消息、assistant 最终回复、`task_complete`。
- 提取成功/失败的 `spawn_agent`、`send_input`、`close_agent`。
- 根据成功创建的子 agent id 和 `<subagent_notification>` 递归定位子会话。
- 输出工具失败、关键验证输出、子 agent 通知和最终状态证据。

脚本不会替 agent 下结论；最终总结必须由 agent 阅读脚本输出后归并。

## 手工补查规则

脚本输出不完整时，只允许继续查会话存储区：

```bash
find ~/.codex -type f -name "*<会话id>*" -print
```

或在已定位的会话 JSONL 中查：

```bash
rg -n "spawn_agent|send_input|close_agent|subagent_notification|task_complete|final_answer" <会话文件>
```

仍然不能转去读取会话中提到的业务项目文件。

## 总结格式

最终回答要面向接手者，直接给最新状态，不写扫描过程流水账。

必须包含：

- 主会话 id 与是否找到主会话文件。
- 是否发现子 agent；哪些子 agent 的会话文件已读取，哪些未找到。
- 用户原始目标或最后一次用户追加目标。
- agent 工作最终状态：已完成、未完成、失败、被取消、不再处理的事项。
- 会话中记录的验证结果、上传结果、测试结果。
- 明确剩余风险：例如仅来自会话记录、未实时复验、某子会话缺失。

不要包含：

- 大段原始 JSONL。
- 会话里操作过的源码内容。
- 会话外的推测。
- 对当前代码/数据库/线上服务的实时判断。
