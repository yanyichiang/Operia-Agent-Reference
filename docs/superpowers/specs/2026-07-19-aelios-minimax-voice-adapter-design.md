---
date: 2026-07-19
status: proposed
scope: Operia Agent Voice Studio, provider-neutral voice profiles, MiniMax T2A, Voice Design and Voice Clone
owner: agent.example.com
production_state: disabled
---

# Operia MiniMax Voice Adapter 最小实现设计

## 1. 决策

在 Agent-owned Voice Studio 中新增 provider-neutral voice contract 与默认关闭的 MiniMax adapter。
首个实现只覆盖同步 T2A、Voice Design、快速 Voice Clone、voice 查询与删除；MiniMax 不提供本阶段
的 STT，也不改变 Telegram 对何时发送语音、voice note/audio 与文字降级的所有权。

本设计不授权配置 MiniMax key、启用 Provider、上传任何声音、创建 clone、调用付费 API、部署生产
或执行 owner cutover。所有本地测试必须使用 synthetic bytes 与 mock fetch；dry-run 必须在网络层之前
结束。

Clone 不是普通媒体生成操作。没有可审计的权利声明、样本来源证明、owner approval、成本预留和
preview gate 时，系统不得上传样本或创建 provider voice。创建成功的音色也不得自动设为 default，
不得自动启用生产合成。

## 2. 官方合同核验基线

核验日期为 2026-07-19，只采用 MiniMax 当前官方文档：

- [API Overview](https://platform.minimax.io/docs/api-reference/api-overview)
- [T2A HTTP](https://platform.minimax.io/docs/api-reference/speech-t2a-http)
- [Upload Clone Audio](https://platform.minimax.io/docs/api-reference/voice-cloning-uploadcloneaudio)
- [Upload Prompt Audio](https://platform.minimax.io/docs/api-reference/voice-cloning-uploadprompt)
- [Voice Clone](https://platform.minimax.io/docs/api-reference/voice-cloning-clone)
- [Voice Design](https://platform.minimax.io/docs/api-reference/voice-design-design)
- [Get Voice](https://platform.minimax.io/docs/api-reference/voice-management-get)
- [Delete Voice](https://platform.minimax.io/docs/api-reference/voice-management-delete)
- [Rate Limits](https://platform.minimax.io/docs/guides/rate-limits)
- [Pay as You Go](https://platform.minimax.io/docs/guides/pricing-paygo)

### 2.1 T2A

| 项目 | 当前官方合同 |
| --- | --- |
| Endpoint | `POST https://api.minimax.io/v1/t2a_v2`；`api-uw.minimax.io` 是可选低 TTFA endpoint，不作为默认值 |
| Auth | `Authorization: Bearer <API_key>`，只允许服务端 secret reference |
| 当前模型 | `speech-2.8-hd`、`speech-2.8-turbo` |
| 兼容旧模型 | `speech-2.6-hd`、`speech-2.6-turbo`、`speech-02-hd`、`speech-02-turbo`、`speech-01-hd`、`speech-01-turbo`；新 profile 不默认选择旧模型 |
| 文本限制 | 少于 10,000 characters；超过 3,000 建议 streaming。本阶段 Operia 继续保留更窄的 4,000-character hard limit |
| Voice | `voice_setting.voice_id` 支持 system、clone、voice-design voice |
| Voice settings | speed `[0.5, 2]`、vol `(0, 10]`、pitch `[-12, 12]`；emotion 受模型支持矩阵约束 |
| Audio | `mp3`、`pcm`、`flac`、`wav`、`pcmu_raw`、`pcmu_wav`、`opus`；sample rate 为 `8000/16000/22050/24000/32000/44100`，channel 为 `1/2` |
| Transport | 非 streaming 可返回 `hex` 或 24 小时 URL；本阶段只允许 `stream=false + output_format=hex`，避免把临时 provider URL 暴露给浏览器或渠道 |
| Usage | `extra_info.usage_characters` 是可计费字符数；同时记录 `trace_id`，但不得记录输入全文 |
| Success | HTTP 200 不足以表示成功；必须同时要求 `base_resp.status_code === 0` 和合法 response shape |

Telegram 首选 `audio_setting.format=opus`、mono，采样率使用 MiniMax 明确支持的 `32000` 或
`44100`，不得复制 ElevenLabs 的 `opus_48000_64` 字符串。若真实 canary 证明 Telegram 对返回的
Ogg/Opus 不兼容，再在 channel adapter 做有界转码；不得让语音失败阻塞文字投递。

### 2.2 Voice Clone

1. `POST /v1/files/upload`，multipart purpose=`voice_clone`：`mp3/m4a/wav`，10 秒至 5 分钟，
   最大 20 MB。
2. 可选 prompt audio 使用同一路径、purpose=`prompt_audio`：`mp3/m4a/wav`，少于 8 秒，
   最大 20 MB；一旦提供，`prompt_audio` 与 `prompt_text` 必须同时存在。
3. `POST /v1/voice_clone`：必填 `file_id` 与 caller-defined `voice_id`。voice ID 长度 8-256，
   英文字母开头，只含字母、数字、`-`、`_`，不能以 `-` 或 `_` 结尾，并且必须唯一。
4. 可选 preview `text` 最长 1,000 characters；提供 text 时 model 必填。clone endpoint 的 preview
   按 T2A characters 计费。
5. `text_validation` 最长 200 characters，配合 accuracy `[0,1]` 做 ASR 相似度检查；本实现把
   10-30 秒、可在 200 characters 内准确转写的干净样本作为首版 Operia policy envelope，并要求
   `text_validation`，默认 accuracy `0.7`。
6. 默认 `need_noise_reduction=false`、`need_volume_normalization=false`。只有 owner 在 preview 前
   明确选择时才改变；不得把清理过的样本冒充原始来源。
7. preview 设置 `aigc_watermark=true`；生产 T2A 不宣称官方支持同一字段。

官方计费/生命周期语义：调用 clone endpoint 本身不立即收取 $1.5 clone fee；首次用该 clone
执行 T2A 时收取。未在 168 小时内执行 T2A 的临时 clone 会被删除。Operia 因此必须把
`remote_created` 与 `activated_by_t2a` 分成两个状态，不能在 clone 成功时记录成 permanent/active。

### 2.3 Voice Design

`POST /v1/voice_design` 要求 `prompt` 与最长 500 characters 的 `preview_text`，可选 caller-defined
`voice_id`，返回 `voice_id` 与 hex `trial_audio`。当前 endpoint schema **没有 model 字段**；虽然
API Overview 列出了 Voice Design 可关联的 speech models，adapter 不得自行向 request 注入 model。

官方页面同时给出两层成本：Voice Design preview 为 $30/M characters；Pay-as-you-go 表列 Voice
Design 为 $3/voice，API Overview 说明 generation fee 在首次 T2A 使用时收取。成本 projection
必须分别显示 `preview_character_estimate` 与 `deferred_voice_activation_fee`，不得把二者合并成
“免费预览”。同样，未在 168 小时内用于 T2A 的 voice 是 temporary。

### 2.4 Rate limits 与价格入口

当前官方通用 rate limit 为 T2A 60 RPM、Voice Clone 60 RPM、Voice Design 20 RPM。Operia 的
本地并发与日预算必须更窄，并把 429/1002/1039 视为可重试但不可自动重复付费 mutation。

当前 pay-as-you-go 入口列价：

| 项目 | 官方列价 | 预算换算 |
| --- | --- | --- |
| `speech-2.8-turbo` | $60/M characters | 60 micro-USD/character |
| `speech-2.8-hd` | $100/M characters | 100 micro-USD/character |
| Rapid Voice Cloning | $1.5/voice | 1,500,000 micro-USD deferred activation fee |
| Voice Design | $3/voice | 3,000,000 micro-USD deferred activation fee |
| Voice Design preview | $30/M characters | 30 micro-USD/character |

价格是带 `observed_at` 与 source URL 的估算快照，不是账单真源。实际结算以 MiniMax account plan
和 provider usage 为准；adapter 只记录官方返回的 `usage_characters`，不能虚构美元实付额。

## 3. 现有 Voice Studio contract 审计

### 3.1 可复用部分

- Provider runtime 已有 fail-closed `enabled + configured` 门、server-only credential、timeout、
  response byte limit、错误脱敏与 mockable fetch。
- Voice Studio browser mutation 已有应用会话、Origin/CSRF、idempotency key、preview TTL、R2
  `private, no-store`、审计事件与一次性 claim。
- `speak` 已要求 default voice，媒体由 Agent 保存为短期 `mediaRef`，Telegram 不接 provider key。
- TTS 失败不应阻塞文字投递的既有边界继续有效。

### 3.2 必须先修的 contract gap

| 现状 | MiniMax 风险 | 最小修正 |
| --- | --- | --- |
| `ProviderId`、registry 与 runtime 只识别 `elevenlabs` | 不能表达 provider-neutral Voice | 增加 `minimax` snapshot/capability，但默认 disabled/unconfigured |
| `voice_profiles.voice_id` 是全局主键 | 不同 provider ID 可碰撞，也不知道 voice 类型/生命周期 | 使用内部 `profile_id` 主键，保存 `provider_id + provider_voice_id + kind + lifecycle_status` |
| preview table 固定 `generated_voice_id` | MiniMax Design 直接返回 voice ID，Clone 还有 upload/file/consent 阶段 | 新建 provider-neutral job/preview projection，不把 ElevenLabs 两步假设扩散 |
| UI 名称与 configured 状态硬编码 ElevenLabs | 无法正确展示 effective provider/source | Voice Studio 展示 provider catalog、configured/disabled/source；secret 只返回 configured status |
| `synthesize` 假设上游返回裸 audio bytes | MiniMax T2A 返回 JSON 内 hex/URL | MiniMax adapter 只接受 hex，严格解码并派生 MIME |
| 通用 `fetchJson` 使用 JS number | MiniMax upload `file_id` 是 int64，官方示例超出 `Number.MAX_SAFE_INTEGER` | 对 file upload response 使用保留十进制 token 的 lossless parser；请求用只接受 `/^[0-9]+$/` 的 raw-int serializer |
| HTTP success 被通用 JSON parser 当成功 | MiniMax HTTP 200 仍可能 `base_resp.status_code != 0` | 每个 response 先验 `base_resp`，映射安全 upstream code/trace ID |
| profile 无 consent/provenance/cost | 无法证明 clone 合法，也无法审计付费激活 | clone job 强制 rights attestation + source proof + approval + usage/cost ledger |
| 只有一个 `VOICE_ENABLED` | 开启 ElevenLabs 会意外使 MiniMax 可用 | provider-specific enable flag + global hard gate，二者均 true 才可调用 |
| 只有审计日志，没有 voice job 状态机 | 未知结果可能被重复上传/克隆/计费 | mutation checkpoint、provider request correlation、`attention_required`，未知结果禁止自动重放 |

## 4. Canonical owner 与 keys

所有下列事实仍由 `agent.example.com` 拥有；这不是 owner transfer：

| Key | Schema/默认 | Scope | Resolution | 说明 |
| --- | --- | --- | --- | --- |
| `agent.voice.provider.enabled` | boolean / false | global, channel | deny_only | 既有全局 hard gate |
| `agent.voice.providers.minimax.enabled` | boolean / false | global | deny_only | MiniMax 独立 kill switch |
| `agent.voice.default_provider` | enum / `elevenlabs` compatibility seed | global, channel | replace_within_envelope | 只引用 enabled/configured provider |
| `agent.voice.default_profile_id` | internal profile locator / null | global, channel | replace_within_envelope | 不直接暴露 provider voice ID |
| `agent.voice.clone.enabled` | boolean / false | global | deny_only | clone/upload 独立 dangerous gate |
| `agent.voice.budget.daily_micro_usd` | integer / 0 | global, channel | numeric_min | 0 表示无付费调用授权，不表示 unlimited |
| `agent.voice.max_synthesis_characters` | integer / 4000 | global, channel | numeric_min | 永远不超过 provider hard limit |

MiniMax API key 是 Agent server-side secret reference，不是 ControlValue。manifest/bootstrap 只返回
`configured: boolean`。Telegram 只消费生效 profile 与 provider projection，继续拥有发送策略。

## 5. Provider-neutral 类型

```ts
type VoiceProviderId = "elevenlabs" | "minimax";
type VoiceProfileKind = "system" | "designed" | "cloned";
type VoiceLifecycleStatus =
  | "staged"
  | "remote_created"
  | "preview_ready"
  | "owner_selected"
  | "activated_by_t2a"
  | "expired"
  | "deleted"
  | "attention_required";

type VoiceProfile = {
  profileId: string;
  providerId: VoiceProviderId;
  providerVoiceId: string;       // private owner projection; channel receives profileId
  kind: VoiceProfileKind;
  displayName: string;
  lifecycleStatus: VoiceLifecycleStatus;
  synthesisDefaults: {
    model: string;
    speed?: number;
    volume?: number;
    pitch?: number;
    emotion?: string;
    languageBoost?: string;
    audioFormat: "opus" | "mp3";
    sampleRate: 32000 | 44100;
  };
  provenanceRef?: string;
  providerCreatedAt?: string;
  activationDeadline?: string;
  selectedAt?: string;
  createdAt: string;
  updatedAt: string;
};

type VoiceProviderCapabilities = {
  tts: boolean;
  stt: boolean;
  voiceDesign: boolean;
  voiceClone: boolean;
  listVoices: boolean;
  deleteVoice: boolean;
};
```

MiniMax capability 固定为 `{tts:true, stt:false, voiceDesign:true, voiceClone:true,
listVoices:true, deleteVoice:true}`。通用 service contract 不得因为当前 ElevenLabs 支持 STT 而要求
所有 voice provider 支持 STT。

## 6. MiniMax adapter 最小接口

```ts
type MiniMaxRuntimeConfig = ProviderRuntimeConfig & {
  providerId: "minimax";
  baseUrl?: "https://api.minimax.io" | "https://api-uw.minimax.io";
};

interface MiniMaxVoiceProvider {
  synthesize(input: MiniMaxTtsInput): Promise<SpeechResult & MiniMaxUsage>;
  designVoice(input: MiniMaxVoiceDesignInput): Promise<MiniMaxDesignedVoice>;
  uploadCloneAudio(input: MiniMaxCloneUploadInput): Promise<{ fileId: string }>;
  uploadPromptAudio(input: MiniMaxPromptUploadInput): Promise<{ fileId: string }>;
  cloneVoice(input: MiniMaxVoiceCloneInput): Promise<MiniMaxClonedVoice>;
  listVoices(type: "system" | "voice_cloning" | "voice_generation" | "all"): Promise<VoiceProjection[]>;
  deleteVoice(input: { kind: "voice_cloning" | "voice_generation"; providerVoiceId: string }): Promise<void>;
}
```

约束：

- `synthesize` 默认 `speech-2.8-turbo`；quality 映射 `speech-2.8-hd`。不得给 MiniMax 发送
  ElevenLabs model/output setting。
- `designVoice` 不接受 model；prompt 和 previewText 由 adapter 验证，trial audio hex 上限解码。
- clone upload 只接受 allowlisted media type、1..20 MB；服务层还要使用可信 probe 校验真实格式与
  duration，不能信任浏览器 filename/MIME。
- `fileId` 始终是 decimal string。任何 number 输入，尤其 unsafe integer，直接拒绝。
- response 只返回安全 code、HTTP status、MiniMax `trace_id`；`status_msg`、secret、原始 sample、
  prompt 或合成文本不得进入错误或日志。
- provider URL 只可来自 static config；拒绝任意 URL、userinfo、非 HTTPS、未知 host、redirect。
- `output_format=url` 不进入首版，避免未知 CDN host、过期 URL 和 SSRF/redirect 边界。

## 7. Clone consent/provenance 门

### 7.1 必填 rights attestation

每个 clone job 必须保存不可空的结构化声明：

```ts
type VoiceCloneProvenance = {
  schemaVersion: 1;
  sourceType: "owner_upload";
  rightsBasis: "self_voice" | "documented_permission" | "licensed_sample";
  attestationText: string;
  attestedByOwnerId: string;
  attestedAt: string;
  consentVersion: "voice-clone-consent-v1";
  sourceSha256: string;
  sourceMediaType: "audio/mpeg" | "audio/mp4" | "audio/wav";
  sourceBytes: number;
  sourceDurationMs: number;
  sampleTranscriptSha256: string;
  retention: "delete_after_provider_upload";
};
```

UI 必须要求 owner 明确确认：自己是说话人，或拥有可证明的克隆和合成授权；不得使用默认勾选、
笼统服务条款或历史 approval 代替本次声明。`documented_permission/licensed_sample` 需保存私有
evidence reference；审计日志只保存 reference/hash，不保存证件、合同或声音。

缺任一字段、哈希不一致、音频 probe 不通过、duration 不在 Operia 10-30 秒 envelope、transcript
为空/超过 200 characters、consent 版本过期时，job 必须停在 `blocked_by_provenance`，且 fetch
调用次数为 0。

### 7.2 私有 staging 与清理

- 原始 sample 进入 Agent 私有、不可公开读取的 staging object，短 TTL、`no-store`，不进入 D1、
  Memory、Telegram、日志或 fixture。
- provider upload 成功记录 exact decimal file ID 后，立即 best-effort 删除本地原始 object；删除
  失败进入 `attention_required` 并阻止继续 clone。
- provider file cleanup 通过 MiniMax File Management 的受控删除能力作为后续 implementation gate；
  未实现前必须在 UI/approval 中披露 provider-side retention 未被 Operia 验证。
- clone/profile 删除是危险 mutation，要求 owner confirmation、idempotency 与 provider kind；不得
  只删本地行而遗留 provider voice。

## 8. Job、审批与成本状态机

```text
draft
  -> validated_offline
  -> blocked_by_provenance | awaiting_owner_approval
  -> budget_reserved
  -> uploading_source
  -> source_uploaded
  -> creating_remote_voice
  -> remote_created
  -> awaiting_paid_preview_approval
  -> preview_synthesizing
  -> preview_ready
  -> owner_selected
  -> production_enablement_pending
  -> activated_by_t2a

unknown timeout after any remote mutation -> attention_required (never blind retry)
owner reject / expiry -> cancelled or expired -> cleanup pending -> cleaned
```

Design 从 `budget_reserved` 直接进入 `creating_remote_voice`；其 response 同时包含 trial preview。
Clone 默认调用 `/voice_clone` 时不带 preview text，避免把 remote creation 与付费试听合并。试听使用
单独 T2A：这一步可能触发 $1.5 activation fee，因此必须显示“试听会激活并收费”，取得新的、绑定
`job_id + profile_id + text_hash + model + estimate` 的 approval。

预算使用 integer micro-USD，禁止浮点：

```text
tts_estimate = characters * model_micro_usd_per_character
clone_activation_reserve = 1_500_000
design_activation_reserve = 3_000_000
design_preview_estimate = preview_characters * 30
```

approval 必须绑定 operation、arguments hash、pricing source/version、estimated max、daily remaining、
idempotency key 与过期时间。Provider 返回 `usage_characters` 后写实际 usage facts 并释放未使用预留。
没有官方 response 能证明实际美元扣款时，状态使用 `estimated`，不能标记 `billed`。

## 9. 存储与兼容迁移

不要原地把 MiniMax 字段塞入现有 `voice_profiles.settings_json`。实现时采用 additive migration：

1. 新建 `voice_profiles_v2`，内部 `profile_id` 主键，unique `(provider_id, provider_voice_id)`。
2. 新建 `voice_jobs`、`voice_job_events`、`voice_provenance`、`voice_usage_log`；事件保存 hash/计数，
   不保存 prompt、全文或声音。
3. 将现有 ElevenLabs rows 投影为 `provider_id=elevenlabs`、`kind=designed`、
   `lifecycle_status=activated_by_t2a` 的 compatibility view；不能仅因本地存在就猜测 provider
   仍持有 voice，现场 list/controlled E2E 前标记 `verification=pending`。
4. 新写只进入 v2；旧读继续兼容，做 old/new projection 比对。
5. coordinator 明确批准后才切换 default-profile reads；观察与回滚窗口结束前不删旧表。

虽然 owner 不变，这仍涉及执行 read-path cutover，必须保留 feature flag 与 dual-read evidence。

## 10. 本地 synthetic/dry-run 测试计划

所有测试在没有 `MINIMAX_API_KEY`、`MINIMAX_VOICE_ENABLED=false`、`VOICE_ENABLED=false` 下运行。
fixture 只含程序生成的无意义 bytes/hex 和虚构 ID，不含真人或真实声音。

### 10.1 Adapter unit/contract

1. disabled、missing credential 均在 fetch 前失败；snapshot/log/error 不含伪 secret。
2. T2A request snapshot：正确 model、text、`stream=false`、`output_format=hex`、MiniMax voice/audio
   settings；不出现 ElevenLabs 字段。
3. 合法 hex 解码为 bounded bytes/MIME；奇数长度、非 hex、超限、缺 audio、URL output 全拒绝。
4. HTTP 200 + nonzero `base_resp.status_code` 映射到安全 ProviderError；`status_msg` 不透传。
5. 保存 `trace_id` 与 `usage_characters`；不保存 text。
6. upload 使用 FormData 且不手写 multipart boundary；format/size 边界 fail-closed。
7. 用 `123456789012345680` fixture 验证 file ID 完整 round-trip；任何 JS unsafe number 输入失败。
8. clone voice ID 的最短/最长、首尾、字符集、重复错误；prompt audio 必须 audio+text 成对。
9. Clone request 默认无 preview text/model；有 preview 时 text <=1000 且 model allowlisted。
10. `text_validation` <=200、accuracy `[0,1]`；默认 watermark=true。
11. Voice Design request 不含 model；preview <=500；trial hex bounded。
12. timeout/429/1002/1039 分类可重试，但 remote mutation 未知结果进入 attention_required，不自动
    发第二个请求。
13. Base URL 只允许两个 exact HTTPS host；redirect、HTTP、userinfo、端口、任意 path 均拒绝。

### 10.2 Consent、approval、budget

1. rightsBasis/attestation/evidence/hash/duration/transcript 任一缺失：status=
   `blocked_by_provenance`，fetch count=0。
2. synthetic sample 哈希或 probe mismatch：fetch count=0，staging object 被清理。
3. consent 合法但 approval 缺失/过期/arguments hash 不同：fetch count=0。
4. daily budget=0 或 reserve 超限：fetch count=0。
5. 同 idempotency key 返回同 job；不同 body 重用 key 返回 conflict。
6. upload 成功后本地 sample 删除；删除失败阻止 clone 并进入 attention_required。
7. clone remote_created 后 preview approval 明确包含 activation fee；未批准不得 T2A。
8. Design preview 显示 preview-character estimate 和 deferred $3 activation 两项。

### 10.3 Runtime/profile/UI integration

1. provider catalog 同时显示 ElevenLabs/MiniMax，MiniMax 为 disabled/unconfigured；bootstrap 不含 key。
2. provider voice ID collision 不影响不同 provider profile；渠道只接 internal profile ID。
3. MiniMax profile 不是 `owner_selected + enabled + configured` 时 `speak` fail-closed。
4. Telegram fallback：TTS mock failure 后文字投递成功，音频不进入无界重试。
5. preview audio 是 private/no-store、TTL 到期 410；未授权 profile/job locator 404/403。
6. audit/manifest/deep link 不含 sample、transcript、prompt、text、file ID、provider voice ID 或 secret。
7. dual-read fixture 中 ElevenLabs legacy projection 与 v2 effective profile 一致。

建议新增命令：

```text
npm run typecheck
node scripts/verify-minimax-voice-provider.mjs
node scripts/verify-agent-voice-consent.mjs
node scripts/verify-agent-voice-studio.mjs
node scripts/verify-p2-providers.mjs
```

这些脚本只能 mock `fetch`。测试中如出现对 `api.minimax.io` 或 `api-uw.minimax.io` 的真实 DNS/HTTP
访问即失败。

## 11. 分阶段启用门

### Gate A：本地合同（本 spec 的下一实现阶段）

- provider/type/storage additive implementation；
- synthetic tests 全绿；
- MiniMax disabled、无 secret、无网络、无真实 sample；
- security review 覆盖 int64、SSRF/redirect、consent、日志与 unknown-result retry。

### Gate B：只读生产投影

需 coordinator 另行授权部署。只展示 MiniMax `disabled/unconfigured`、keys/owner/source/预算 0，
不接 key、不开放 upload、不创建 voice。

### Gate C：受控 synthetic paid canary

需 owner 在当回合授权 key 接入、预算和具体付费调用。只用人工生成/明确可用的 synthetic sample，
依次验证 upload、clone/design、preview、usage、cleanup、list/delete；完成后 Provider 回到 disabled。

### Gate D：owner voice E2E

需新的明确授权、rights attestation、真实样本 retention disclosure、成本 approval。验证 profile 选择、
T2A、private mediaRef、Telegram voice note 与文字 fallback。仍不自动启用常驻 Provider。

### Gate E：生产启用

只有 owner 验收后才能设置 provider-specific enablement、非零 budget 和 default profile。发布矩阵、
E2E、回滚 flag、删除/retention 与 operations ledger 由 coordinator 统一处理。

## 12. 回滚与严格未完成

回滚只需关闭 `agent.voice.providers.minimax.enabled`，default provider/profile 回到已验证的
ElevenLabs 或 text-only；profile/job/provenance/usage rows 保留用于审计，不删除历史。未知 provider
mutation 先标记 attention_required 并人工 query/list，禁止为了“确认”而重放付费请求。

本 spec 完成后仍严格未完成：MiniMax adapter 代码、schema migration、UI、consent evidence store、
provider file cleanup、price snapshot job、任何 key/configuration、真实 API 验证、音质评估、Telegram
真实语音 E2E、部署、Provider enablement 和 owner acceptance。
