import assert from "node:assert/strict";
import test from "node:test";
import type { AgentTimelineItem } from "../server/paseo-types";
import { PROMPT_MAX_BYTES, RECAP_EXCHANGES, buildRecapPrompt, collectExchanges, endsWithReply, excerptBytes, formatHistory, isCompacting, maskedText, parseRecapOutput, recapInstructions, suggestedReply } from "../server/recap-prompt";
import { InsightReportError } from "../server/insight-analysis";

const user = (text: string): AgentTimelineItem => ({ type: "user_message", text });
const assistant = (text: string): AgentTimelineItem => ({ type: "assistant_message", text });
const tool = (output: string): AgentTimelineItem => ({ type: "tool_call", callId: `call-${output.length}`, name: "shell", status: "completed", error: null, detail: { type: "shell", command: "cat secrets.txt", output } } as unknown as AgentTimelineItem);
const bytes = (text: string) => Buffer.byteLength(text, "utf8");
const zh = { language: "zh-CN", languageName: "简体中文", suggestions: true };
const FAKE_KEY = "sk-" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4";
// Built at run time, so the source holds no key armour for leak scanners to flag.
const armour = (edge: "BEGIN" | "END") => `${"-".repeat(5)}${edge} PRIVATE KEY${"-".repeat(5)}`;

test("a recap reads only what you and the agent wrote: no tool output, reasoning, errors or notices; chunks of one reply are joined", () => {
  const timeline: AgentTimelineItem[] = [
    user("把存储层拆出来"), { type: "reasoning", text: "思考：先看看目录" }, tool("password=hunter2hunter2 SECRET OUTPUT"),
    assistant("好的，"), assistant("已拆出 storage 包。"), { type: "error", message: "stack trace with paths" }, { type: "notification", level: "info", message: "notice" },
    { type: "todo", items: [{ text: "跑测试", completed: false }] }, user("再跑一下测试"), assistant("测试全部通过。"),
  ];
  const exchanges = collectExchanges(timeline);
  assert.deepEqual(exchanges, [{ user: "把存储层拆出来", assistant: "好的，已拆出 storage 包。" }, { user: "再跑一下测试", assistant: "测试全部通过。" }]);
  const prompt = buildRecapPrompt(timeline, zh)!;
  for (const hidden of ["SECRET OUTPUT", "cat secrets.txt", "思考", "stack trace", "notice", "跑测试"]) assert.equal(prompt.includes(hidden), false, hidden);
  assert.ok(prompt.includes("User: 把存储层拆出来\n\nAssistant: 好的，已拆出 storage 包。"));
});

test("this turn and at most seven before it: the oldest exchanges beyond eight are not read at all", () => {
  const timeline = Array.from({ length: 12 }, (_, index) => [user(`第 ${index + 1} 个请求`), assistant(`第 ${index + 1} 个回复`)]).flat();
  const exchanges = collectExchanges(timeline);
  assert.equal(exchanges.length, RECAP_EXCHANGES);
  assert.equal(exchanges[0]!.user, "第 5 个请求");
  assert.equal(exchanges.at(-1)!.assistant, "第 12 个回复");
  // A heartbeat turn (no new message) adds to the exchange it follows; replies before the window's first message are not read.
  assert.deepEqual(collectExchanges([assistant("开场白"), user("开始"), assistant("第一段"), assistant("，心跳续写")]), [{ user: "开始", assistant: "第一段，心跳续写" }]);
  assert.equal(buildRecapPrompt([assistant("只有回复")], zh), null, "nothing to recap without a message from you");
});

test("credentials are masked in every message before anything is cut, and the summary the model writes is masked again", () => {
  const key = `${armour("BEGIN")}\n${"QUJD".repeat(4000)}\n${armour("END")}`;
  // A long first message: cutting first would keep the key's body without its header.
  const timeline = [user(`${key}\n部署的时候用这个 token=${FAKE_KEY}`), assistant(`已经配置好 api_key: "${FAKE_KEY}"`), ...Array.from({ length: 6 }, (_, index) => [user(`问题 ${index} ${"细节".repeat(3000)}`), assistant(`回答 ${index} ${"说明".repeat(3000)}`)]).flat()];
  const prompt = buildRecapPrompt(timeline, zh)!;
  assert.ok(bytes(prompt) <= PROMPT_MAX_BYTES, `${bytes(prompt)} bytes`);
  for (const leaked of [FAKE_KEY, "QUJDQUJD", "BEGIN PRIVATE KEY"]) assert.equal(prompt.includes(leaked), false, leaked);
  const parsed = parseRecapOutput(JSON.stringify({ summary: `部署脚本已写好，token=${FAKE_KEY}`, next: "跑一遍部署", reply: null }), { suggestions: true });
  assert.equal(parsed.summary.includes(FAKE_KEY), false);
  assert.match(parsed.summary, /redacted\]/);
});

test("a suggested reply that masking would change is dropped, not masked; the summary and next step are masked (B6)", () => {
  // Built at run time, as the credential formats the masker knows.
  const github = "ghp_" + "a1".repeat(18), line = `Use ${github}`;
  const parsed = parseRecapOutput(JSON.stringify({ summary: line, next: line, reply: line }), { suggestions: true });
  assert.equal(parsed.reply, null);
  assert.equal(parsed.summary.includes(github), false);
  assert.equal(parsed.next?.includes(github), false);
  for (const reply of [line, `"${line}"`, `Deploy with ${FAKE_KEY}`, `用 ${github} 推上去`]) assert.equal(suggestedReply(reply), null, reply);
  assert.equal(parseRecapOutput(JSON.stringify({ summary: "S", next: null, reply: "Use the staging branch" }), { suggestions: true }).reply, "Use the staging branch");
});

test("a message longer than 256 KB is not sent at all, wherever a key sits in it; the prompt says it was left out (BR2)", () => {
  const limit = 256 * 1024, window = 128 * 1024, value = "FAKE_REVIEW_VALUE_" + "b2".repeat(14), github = "ghp_" + "a1".repeat(18);
  assert.equal(maskedText("a".repeat(limit)), "a".repeat(limit), "up to 256 KB: masked whole and sent");
  assert.equal(maskedText("a".repeat(limit + 1)), "[Message too long, not sent]");
  // The review's shape: a cut 128 KB from the end separated the value from the name or prefix marking it, and the rest
  // masked down to a few bytes, so no budget cut it away again.
  const cut = (marker: string, secret: string) => `api_key=${"a".repeat(window - 9)}\n${marker}${secret}\napi_key=${"b".repeat(window - secret.length - 9)}`;
  const texts = [cut("api_key=", value), cut("ghp_", "a1".repeat(18)), `${github} ${"x".repeat(limit)}`, `${"x".repeat(limit)} token=${value}`,
    `${"x".repeat(limit / 2)} password=${value} ${"y".repeat(limit / 2)}`, `${armour("BEGIN")}\n${"QUJD".repeat(limit / 4)}\n${armour("END")}`];
  for (const text of texts) {
    assert.ok(text.length > limit);
    const prompt = buildRecapPrompt([user("看看这段日志"), assistant(text), user(text), assistant("已看完，没有异常")], zh)!;
    for (const secret of [value, github, "a1a1a1a1", "b2b2b2b2", "QUJDQUJD"]) assert.equal(prompt.includes(secret), false, secret);
    assert.match(prompt, /User: \[Message too long, not sent\]/);
    assert.match(prompt, /Assistant: \[Message too long, not sent\]/);
    assert.match(prompt, /Assistant: 已看完，没有异常/);
  }
});

test("a message up to 256 KB is still masked whole before anything is cut, wherever its keys sit (BR2)", () => {
  const value = "FAKE_REVIEW_VALUE_" + "b2".repeat(14), github = "ghp_" + "a1".repeat(18), third = 80 * 1024;
  const text = `api_key=${"a".repeat(third)}\napi_key=${value}\n${github} ${"b".repeat(third)} token=${value} ${"c".repeat(third)}结尾`;
  assert.ok(text.length <= 256 * 1024);
  const prompt = buildRecapPrompt([user(text), assistant("好的")], zh)!;
  assert.ok(bytes(prompt) <= PROMPT_MAX_BYTES);
  for (const secret of [value, github, "a1a1a1a1", "b2b2b2b2"]) assert.equal(prompt.includes(secret), false, secret);
  assert.match(prompt, /User: api_key=\[redacted\]\napi_key=\[redacted\]/, "the start is kept, masked");
  assert.match(prompt, /c结尾/, "and the end");
});

test("the budget drops the oldest exchanges first, then cuts every message to its start and end; the newest stays", () => {
  const exchanges = Array.from({ length: 8 }, (_, index) => ({ user: `请求 ${index} ${"甲".repeat(800)}`, assistant: `回复 ${index} ${"乙".repeat(800)}` }));
  const dropped = formatHistory(exchanges, 12_000);
  assert.ok(bytes(dropped) <= 12_000);
  assert.ok(dropped.startsWith("[Earlier exchanges omitted]"));
  assert.ok(dropped.includes("请求 7") && dropped.includes("回复 7"), "the newest exchange stays");
  assert.equal(dropped.includes("请求 0 "), false, "the oldest went first");
  // One exchange alone too large: its start and its end, marked.
  const single = formatHistory([{ user: `开始${"丙".repeat(20_000)}结束`, assistant: `回答开始${"丁".repeat(20_000)}回答结束` }], 4_000);
  assert.ok(bytes(single) <= 4_000);
  assert.ok(single.includes("开始") && single.includes("结束") && single.includes("回答结束") && single.includes("[... excerpted ...]"));
  // The cut never splits a character.
  const cut = excerptBytes("汉".repeat(1000), 101);
  assert.equal(cut.includes("�"), false);
  assert.ok(bytes(cut) <= 101);
});

test("the whole prompt stays within 32 KB with the instructions, title and history", () => {
  const timeline = Array.from({ length: 30 }, (_, index) => [user(`${index} ${"long ".repeat(5000)}`), assistant(`${index} ${"reply ".repeat(5000)}`)]).flat();
  const prompt = buildRecapPrompt(timeline, { language: "en", languageName: "English", suggestions: true, title: `A title ${"t".repeat(500)}` })!;
  assert.ok(bytes(prompt) <= PROMPT_MAX_BYTES, `${bytes(prompt)} bytes`);
  assert.match(prompt, /Session title: A title t+…/);
  assert.ok(prompt.indexOf("Conversation:\n") > 0);
});

test("the answer's language and lengths follow the plugin language: characters for Chinese, words for English; the reply only when asked", () => {
  const chinese = recapInstructions(zh), english = recapInstructions({ language: "en", languageName: "English", suggestions: false });
  assert.match(chinese, /in 简体中文, at most 25 characters/);
  assert.match(chinese, /next: .*in 简体中文, at most 12 characters/s);
  assert.match(chinese, /reply: the message the user is most likely to send next/);
  assert.match(english, /in English, at most 20 words/);
  assert.match(english, /in English, at most 8 words/);
  assert.match(english, /reply: always null\./);
  assert.match(recapInstructions({ language: "ja", languageName: "日本語", suggestions: false }), /at most 25 characters/);
});

test("only a turn that ended on a reply with text is recapped, and none while the context is being compacted", () => {
  assert.equal(endsWithReply([user("q"), assistant("done"), { type: "todo", items: [] }, { type: "reasoning", text: "…" }]), true);
  assert.equal(endsWithReply([user("q"), assistant("working"), tool("out")]), false);
  assert.equal(endsWithReply([user("q"), { type: "error", message: "boom" }]), false);
  assert.equal(endsWithReply([user("q"), assistant("   ")]), false);
  assert.equal(isCompacting([user("q"), { type: "compaction", status: "loading" } as AgentTimelineItem, assistant("a")]), true);
  assert.equal(isCompacting([user("q"), { type: "compaction", status: "completed" } as AgentTimelineItem, assistant("a")]), false);
});

test("the answer is read from the Grok envelope or plain text; with the answer repeated, the last object that fits wins", () => {
  const envelope = JSON.stringify({ structured_output: { summary: "拆分存储层：迁移脚本已写好并通过测试", next: "跑集成测试", reply: "先跑集成测试" }, usage: { input_tokens: 10 } });
  assert.deepEqual(parseRecapOutput(envelope, { suggestions: true }), { summary: "拆分存储层：迁移脚本已写好并通过测试", next: "跑集成测试", reply: "先跑集成测试" });
  const repeated = `{"summary":"第一版","next":null,"reply":null}{"summary":"Recap: 第二版","next":"下一步：合并","reply":"合并吧"}`;
  assert.deepEqual(parseRecapOutput(JSON.stringify({ text: repeated }), { suggestions: true }), { summary: "第二版", next: "合并", reply: "合并吧" });
  assert.deepEqual(parseRecapOutput("```json\n{\"summary\":\"**Goal**: ship v2\",\"next\":\"none\",\"reply\":\"ok\"}\n```", { suggestions: true }), { summary: "Goal: ship v2", next: null, reply: "ok" });
  // Suggestions off: whatever the model wrote is dropped.
  assert.equal(parseRecapOutput(envelope, { suggestions: false }).reply, null);
  assert.throws(() => parseRecapOutput("not json", { suggestions: true }), InsightReportError);
  assert.throws(() => parseRecapOutput(JSON.stringify({ summary: "", next: null, reply: null }), { suggestions: true }), InsightReportError);
  assert.throws(() => parseRecapOutput(JSON.stringify({ summary: "x" }), { suggestions: true }), InsightReportError, "next and reply are required (null allowed)");
  // A long summary is kept, shortened.
  assert.equal(Array.from(parseRecapOutput(JSON.stringify({ summary: "长".repeat(500), next: null, reply: null }), { suggestions: true }).summary).length, 300);
});

test("a suggested reply is something you would send as it is: short, in your words, never a question, praise, the agent's voice or a risky step", () => {
  for (const ok of ["先跑测试再提交", "用方案 B", "Run the migration", "继续", "ok", "合并到 main", "Ship it."]) assert.equal(suggestedReply(ok), ok, ok);
  assert.equal(suggestedReply("「用方案 B」"), "用方案 B", "quotes come off");
  assert.equal(suggestedReply("Suggestion: run the tests"), "run the tests", "a label comes off");
  for (const no of [null, "", "null", "无", "要我继续吗？", "Should I merge?", "我来跑测试", "I'll run the tests", "谢谢，很好", "Looks good", "1. 跑测试", "第一行\n第二行",
    "/compact", "/clear now", "删除旧分支", "rm -rf build", "force push to main", "部署到生产环境", "把密码发给我", "update the API key", "set token=[redacted]",
    "Fix it. Test it. Ship it.", "do", "这句话实在是太长了我觉得没有人会这样打字发给编码助手吧真的是太长太长了这样不行的啊啊啊啊啊啊啊啊", "one two three four five six seven eight nine ten eleven twelve thirteen"])
    assert.equal(suggestedReply(no), null, String(no));
});

test("a schedule's prompt or another agent's message opens its own exchange (Paseo 0.14 records them as tool calls)", () => {
  const heartbeat = { type: "tool_call", callId: "paseo-system:3f2a", name: "heartbeat", status: "completed", error: null, detail: { type: "plain_text", text: "Schedule \"nightly\" fired.\n检查构建" } } as unknown as AgentTimelineItem;
  const message = { type: "tool_call", callId: "paseo-agent-message:m1", name: "agent_message", status: "completed", error: null, detail: { type: "plain_text", text: "子任务做完了" }, agentMessage: { event: "finished", sender: { id: "c" }, text: "子任务做完了" } } as unknown as AgentTimelineItem;
  const exchanges = collectExchanges([user("开始"), assistant("好的。"), heartbeat, tool("ok"), assistant("构建是绿的。"), message, assistant("已收到。")]);
  assert.deepEqual(exchanges, [{ user: "开始", assistant: "好的。" }, { user: "Schedule \"nightly\" fired.\n检查构建", assistant: "构建是绿的。" }, { user: "子任务做完了", assistant: "已收到。" }]);
  // A tool merely named "heartbeat" opens nothing.
  assert.deepEqual(collectExchanges([user("开始"), { ...(heartbeat as object), callId: "toolu_1" } as AgentTimelineItem, assistant("好")]), [{ user: "开始", assistant: "好" }]);
});
