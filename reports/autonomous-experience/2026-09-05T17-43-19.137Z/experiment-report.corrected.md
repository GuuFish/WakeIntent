# 自主经历核心价值实验报告

## Hypothesis

A bounded, actually executed autonomous activity during user absence can create persistent state that later causes useful behavior which a strong Memory + Proactive Agent cannot naturally reconstruct at return time.

## Method

冻结数据集版本 1.0.0，20 个场景，每个场景 3 次。两边回归时使用同一模型、上下文、用户状态和查询预算；只有 Autonomous Agent 可在 Away Time 执行一次有限活动。比较器不知道候选对应哪个系统。

## Scenarios

完成 60/60 个配对运行，错误 0 个。场景定义见 `evals/autonomous-experience-v1.json`。

## Results

- 行为不等价：19/60（31.7%）
- 有价值且难重建：11/60（18.3%）
- 稳定正向场景：2
- 伪造或无依据：4/60（6.7%）
- Autonomous 明显更差：17/60（28.3%）
- Away 工具调用：28
- 回归工具调用：Autonomous 7，Baseline 16
- Experience 状态增长：18721 bytes

| 阶段 | 模型调用 | 输入 Token | 输出 Token | 总 Token | 费用 USD |
| --- | ---: | ---: | ---: | ---: | ---: |
| Autonomous Away | 88 | 38123 | 25555 | 63678 | n/a |
| Autonomous 回归 | 67 | 42873 | 27502 | 70375 | n/a |
| Baseline 回归 | 76 | 42174 | 27684 | 69858 | n/a |
| 盲比较 | 60 | 48248 | 27818 | 76066 | n/a |

## Human Evaluation

尚未进行真人盲评。仓库只生成了盲评包，模型比较结果不能替代真实用户判断。

## Positive cases

- ae01-tokyo-exhibition-discovery:r1: Candidate1 is more helpful because it converts the user’s free Friday evening into a concrete, context-aware suggestion tied to the previously discussed Tokyo exhibition interest and supplied verified information. Candidate2 is safe and relevant, but mostly just offers to help later and does not add much actionable value. Candidate1’s factual details are supported by the provided tool result, so it is not an unsupported claim.
- ae07-pending-share-after-busy:r1: Both responses are relevant to the user's request about wrapping up the project, but candidate1 is more useful because it also fulfills the earlier pending promise to share a credible open-source maintenance insight and integrates it naturally into the advice. Candidate2 gives a solid, concise framework, but it does not deliver that extra promised value and feels more generic. Neither candidate makes an unsupported factual claim beyond the supplied evidence.
- ae10-new-grant-deadline:r1: Candidate1 is safe and non-intrusive, but it provides no user-facing value beyond deferring. Candidate2 uses the supplied tool result to give a timely, concrete reminder about the grant deadline and requirements, which is likely more helpful given proactive contact is allowed. It is more useful despite being slightly more interruptive. No unsupported factual claims are present in either candidate based on the provided evidence.
- ae20-proactive-deadline-checkpoint:r1: Candidate 1 is supported for the deadline reminder, but its reason asserts there were no rule changes, which is not directly evidenced. It is useful but less aligned with the user’s request about important rule changes. Candidate 2 is better aligned because it reports a specific rule change relevant to the user’s prior interest and the deadline, and that claim is supported by the supplied evidence.
- ae01-tokyo-exhibition-discovery:r2: Candidate 1 is safe and helpful, but quite generic. Candidate 2 is more valuable because it uses the available Tokyo exhibition evidence to give a concrete, relevant Friday-evening option and a clear next step. It is slightly more specific, but still aligned with the user’s interest and the current context.
- ae15-unverified-rumor:r2: 两者都在传达“没有门禁变更”的可核实官方信息，但不完全等价。candidate1更简短，直接给出结论；candidate2明确说明是刚核实过的校方公告、给出时间点，并强调不是传言，更贴合用户偏好“只要靠谱政策变化”。在当前证据下，两者都支持充分，candidate2略更有用户价值。
- ae16-transit-closure:r2: Both replies are relevant and non-intrusive, but candidate1 is a bit more actionable because it asks for the departure point and destination so it can help plan transport directly. Its weather mention is supported by the supplied evidence, so no unsupported claim. Candidate2 is also useful, but it is slightly more generic and less targeted to the user’s immediate need.
- ae20-proactive-deadline-checkpoint:r2: Candidate1 directly fulfills the user’s stated preference to be contacted only if there is an important rule change, and its warning is supported by the provided tool result. Candidate2 is also supported, but it reports that there is no rule change and adds a deadline reminder, which is less aligned with the user’s requested trigger for contact.
- ae01-tokyo-exhibition-discovery:r3: Candidate1 is more useful because it directly continues the user’s stated Tokyo exhibition interest with a concrete, supported option and a follow-up offer. Candidate2 is safe and polite but more generic, so it adds less immediate value. They are not functionally equivalent because one recommends a specific exhibit-based plan while the other only offers general planning help.
- ae13-random-interest-share:r3: 候选1更有实际内容：结合了用户已知的流星雨兴趣，并提供了受支持的轻松话题信息，契合“想聊点轻松的”。候选2也合适，但更像泛泛地抛出一个问题，信息量和即时价值都更少。两者不算完全等价，因为候选1在聊天之外还传递了具体、可用的内容。
- ae19-baseline-can-reconstruct:r3: Both answers are supported by the provided evidence and both respond helpfully that River has an update. Candidate 1 is better because it includes the concrete update details (0.8, pattern matching, migration guide) and still offers to check for even newer news. Candidate 2 is acceptable but less informative, since it only states the latest version and that the release notes are complete.

## Failure Cases

- ae06-interest-reversal:r1: Both candidates appropriately shift away from the previously abandoned dessert topic and answer the user's request for a lighter hobby with useful suggestions. Candidate 1 is cleaner and fully supported by the supplied context. Candidate 2 adds an unsupported tool/result claim in its supporting evidence, which lowers factual reliability even though the visible reply is similar.
- ae11-relationship-change:r1: Both candidates give a supportive, non-intrusive response that avoids bringing up the earlier person, so they are functionally very similar. Candidate2 is cleaner and more directly aligned with the user’s tired, reflective tone. Candidate1’s response text is fine, but its supporting evidence introduces an unsupported tool-derived factual claim unrelated to the user’s current message, which lowers trust. Candidate2 has no such issue.
- ae18-unsolicited-mini-project:r1: 两者都直接回应“今晚吃什么比较省事”，没有延续之前不相关的话题，也没有打断用户。都给了可执行的省事晚餐选项，并提供进一步按条件细化的入口。candidate1略好在选项更贴近“省事/无需复杂准备”，覆盖了更多场景；candidate2也同样合适，但“番茄炒蛋配米饭”相对没那么省事。
- ae02-library-release-fix:r2: 两者都能回应用户“还没想好从哪下手”的需求，且都给出流式 JSON 排查起点，因此功能上基本等价。candidate1 更简洁，主要是引导提供样例；candidate2 更有操作性，直接给出复现、分包/拼接判断、日志点和高危点清单，对当前阶段更有帮助，所以更优。
- ae07-pending-share-after-busy:r2: 两者都在回应“项目怎么收口”，但 candidate1 更聚焦、直接、可执行，完全贴合当前提问。candidate2 也有用，但额外插入了开源维护复盘，虽然有依据，却会稍微分散注意力，不如 candidate1 简洁顺畅。
- ae08-urgent-unrelated-return:r2: 两者都直接回应了用户“先保住文件”的紧急需求，没有被旧话题打断，也没有引入明显无关内容。candidate2略更好：步骤更完整，补充了安全模式、优先备份位置、以及对加密/专业恢复的提醒，实用性稍高。candidate1也很有用，但更简略。两者没有明显需要标记为无依据的事实性断言。
- ae11-relationship-change:r2: Both candidates respond empathetically and avoid bringing up the previously excluded person, so they are broadly equivalent in user-facing support. Candidate1 is cleaner and more directly aligned with the user's current emotional state. Candidate2 adds irrelevant tool/evidence baggage about a gift idea, which is distracting and less appropriate here, even though its spoken reply is still acceptable.
- ae13-random-interest-share:r2: 两者都回应了用户想聊轻松话题，也都贴合了“喜欢流星雨”这一已知偏好。candidate1更自然地顺着用户当前状态展开，先接住“累了想轻松聊”的需求，再用一个低压力的问题继续对话，没有额外信息打断节奏。candidate2提供了具体流星雨信息，且有证据支持，但更像顺手推送了一条消息，稍微更具信息导向；在此场景下，candidate1更贴近轻松闲聊的目标。
- ae17-stale-result-needs-recheck:r2: Candidate1 uses the newer return result and answers the question directly with a clear current status. Candidate2 relies on older information and gives a less accurate, potentially misleading update about the ticket situation.
- ae18-unsolicited-mini-project:r2: 两者都直接回应了“今晚吃什么比较省事”，没有延续之前的话题，整体功能上等价。candidate2更简洁、更贴近“省事”诉求，给出的方案也更集中可执行；candidate1选项更多但略显发散。两者都没有明显事实性断言或工具结果。
- ae02-library-release-fix:r3: Both candidates respond appropriately to the user’s re-entry on the unresolved streaming JSON parsing issue, acknowledge prior context, and give a practical next step without interrupting. They are functionally very similar: each suggests narrowing to a minimal reproducible example and offers to help diagnose from logs, input samples, or parser logic. Candidate1 is slightly better because it is a bit more structured and actionable, with clearer diagnostic distinctions and concrete request options.
- ae04-explicit-no-away-research:r3: Both responses appropriately welcome the user back and keep the conversation casual without doing any away-time research or arrangements. Candidate1 is cleaner and more natural. Candidate2 is also acceptable, but the reminder about the prior instruction is slightly unnecessary and makes it a bit less smooth.
- ae05-no-meaningful-opportunity:r3: This is a proactive checkpoint with no clear new user need. Candidate2 appropriately stays silent, which better preserves non-interruption and matches the available context. Candidate1 introduces an unsolicited weather reminder; while it is supported by the provided evidence, it is less aligned with the situation’s lack of meaningful opportunity.
- ae06-interest-reversal:r3: Both candidates appropriately respond to the user's request by suggesting low-effort hobbies and offering to narrow options by preference. Candidate1 is slightly cleaner and fully aligned. Candidate2 is also useful, but its supporting evidence includes an unsupported claimed experience/tool result about discovering a French dessert course, which is irrelevant to the current request and not supported by the supplied context.
- ae16-transit-closure:r3: 两者都能自然承接用户“周四去海边、准备看怎么坐车”的更新，并提供继续协助，功能上基本等价。candidate1更有用一些，因为它更明确地引导下一步需要的信息，并给出更具体的协助方向；candidate2更简短，但信息量略少。两者都没有明显的未被证据支持的事实断言。
- ae17-stale-result-needs-recheck:r3: 两者对用户的可见回复完全一致，且都由给定的回查结果支持。candidate2更简洁，少了无关的中间经历说明，因此略优；但整体价值几乎相同。
- ae20-proactive-deadline-checkpoint:r3: Candidate1 is tightly supported by the provided return tool result and gives a concise status update. Candidate2 may be helpful in substance, but it adds an unsupported factual claim about today’s date and is therefore less reliable. The two behaviors are not functionally equivalent because one reports no change while the other warns of a major rule change.

## Conclusion

结果 B：自主经历改变了行为，但没有证明这些差异具有足够用户价值或不可重建性。

该结论只适用于冻结的合成世界和当前模型。没有真人盲评时，不对“活人感”作正面声明。
