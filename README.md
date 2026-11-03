# 对话导出 · Conversation Export

在 DeepSeek Harness 的侧边栏会话「…」菜单增加 **导出对话**，下载 JSON 或 Markdown。

## 使用

1. 找到要导出的会话，点击右侧「…」→ **导出对话**。
2. 选择 **Markdown**（便于阅读）或 **JSON**（结构化数据）。
3. 按需勾选“包含工具调用与结果”，点击 **导出**。
4. 文件由浏览器／桌面宿主的下载功能保存；插件提示“已开始下载”，不代表磁盘保存已完成。

不必先打开目标会话；当前打开另一个会话也不会导错。默认格式为 Markdown，每次打开默认关闭工具记录。

## 内容范围

- 人类输入、AI 正文、能够可靠关联的 `ask_user_question` 提问与实际回答。
- 使用完整会话快照中的原始追加消息，保留上下文压缩之前的聊天；不会把压缩替代副本再导出一次。
- 分支会话的继承历史只包含一次，不额外拼接父会话或递归导出子 Agent。
- 可选工具调用／结果；按调用标识关联而不是按文本去重。工具执行失败信息保留在工具结果中。
- 图片、文件只包含附件名称、标识及可用的尺寸等元数据，**不包含附件本体**，也不保证引用能在另一台机器直接打开。
- 不包含思考过程、系统／开发者提示词、运行环境注入、provider replay state、原始流式内容、未提交草稿或生成尝试。
- 导出运行中的会话时，只包含取得快照时已经提交的事件；后续新消息不会加入同一文件。
- 未支持的内容块以安全占位和警告表示，不静默丢弃。问答仅转换能与实际调用、问题 ID 关联的数据；不将任意工具文本推断成用户消息。
- 这是可阅读的**对话导出**，不是 DSH 原始日志备份；不提供导入还原、批量导出或附件打包。PTC 嵌套派发等内部执行记录不属于首版导出范围。

**分享前检查内容。** 聊天本身可能包含个人信息；开启工具记录后，还可能包含命令、本地路径、凭证或其他敏感文本。插件不会自动脱敏，也不会上传到第三方。

## 安装与兼容

首版兼容基线：**DSH 0.2.1-rc.5**。包名：`@local/dsh-conversation-export`。

通过 Harness 插件管理器安装这个目录的绝对路径，或发布／打包后的 bundle。安装会影响当前 profile 下的全部会话，可在“插件”页面禁用或卸载。

本地目录安装是链接，不要删除或移动此插件目录。没有第三方 npm 依赖、构建步骤或安装脚本。不手工编辑 profile 的 package.json 或 cordis.patch.yml。

新安装与替换已加载代码的行为由插件管理器决定。若安装结果要求刷新或重启，请按提示操作；不能通过启动另一个开发服务器更新当前 GUI。此包对未测试的运行时版本不会自动放行。

## 配置

插件行 ID：`local-conversation-export`。

```yaml
maxExportBytes: 67108864
```

`maxExportBytes` 为完整导出文件的 UTF-8 字节上限，默认 **64 MiB**，合法范围 `1..1073741824`（1 GiB）。超限返回明确错误，不返回截断文件。JSON 的格式化开销也计入大小。较大上限会增加 Host 和浏览器内存占用。

## JSON 结构

```json
{
  "schemaVersion": 1,
  "exportedAt": "2026-11-03T09:00:00.000Z",
  "session": {
    "id": "session-id",
    "title": "示例",
    "createdAt": "2026-11-03T08:00:00.000Z"
  },
  "snapshot": {
    "throughSeq": 2,
    "includeTools": false,
    "inheritedEventCount": 0
  },
  "messages": [
    {
      "id": "message-id",
      "seq": 2,
      "time": "2026-11-03T08:01:00.000Z",
      "role": "assistant",
      "content": [{ "type": "text", "text": "你好" }]
    }
  ],
  "warnings": []
}
```

时间为 UTC ISO 8601。空会话 `messages: []`，`throughSeq: null`。分支可能含 `session.parentSessionId`；消息可能含 `interrupted`、`toolCallId`、`isError` 或结构化问题字段。`warnings` 每项为 `{code,message}`。JSON 不是内部 Session 格式，`schemaVersion` 是本插件独立版本。

Markdown 使用中文角色标题，保留正文 Markdown、代码、表格和公式；生成的元数据做转义，工具内容使用独立安全代码围栏。正文中的原始 HTML／链接不自动净化，打开时请使用可信的 Markdown 阅读器。

## Agent 工具

插件在 `tools` 与 `spillStore` 可用时注册 `export_conversation`：

```json
{"format":"json","include_tools":false}
```

可选 `session_id`；省略表示当前会话。其他会话必须符合现有会话检索的同工作区权限规则。结果只返回临时文件 locator、读取提示、文件名、字节数、消息数和警告；完整正文不回灌模型上下文。临时文件受宿主保留策略管理，需要长期保存时请复制到自己的目录。

UI 与工具使用同一序列化实现。UI 导出不写入会话日志、不唤醒 Agent；Agent 工具的正常调用本身会被框架记录在调用者会话中，但不会修改被读取的其他目标会话。

## 安全与实现

- 唯一 Host 读取入口：`sessionQuery.observeSession(id, { signal, projectionMode: 'none' })`；在 `finally` 释放观察租约。
- `GET /api/conversation-export?sessionId=...&format=json|markdown&includeTools=true|false` 通过 Connection 的 exact Fetch 注册，只允许已认证的 owner，继承 Host/Origin 检查。
- 不使用裸 WebServer 路由、不搜索认证令牌、不修改原始日志、不执行聊天中的代码、不读取附件二进制或任意文件路径。
- 服务端校验参数，拒绝未知／重复参数；工具在读取前按真实调用者授权，并在取得快照后再次检查 ID 与工作区。
- UTF-8 文件名经过 Windows 路径／控制字符／设备名处理；下载响应 `no-store`、`nosniff`。
- 插件关闭时取消在途读取、移除路由／工具／菜单；Client 取消请求并回收临时 Blob URL。

## 开发与测试

无外部依赖。使用 Node.js 22 或更新版本：

```powershell
node --check index.js
node --check client.js
node --test tests/export-core.test.js tests/host-service.test.js
```

测试覆盖快照读取与释放、正文/工具/问答、压缩与分支、Unicode、附件元数据、文件名、大小限制、授权、HTTP 参数与错误、取消、工具与 UI 序列化一致性以及 Host 注册清理。单元测试中的宿主接口是受控测试替身，不等同于真实 GUI 下载验收。

代码与原创 SVG 图标按 MIT 许可分发。
