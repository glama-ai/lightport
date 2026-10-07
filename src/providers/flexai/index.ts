import { FLEXAI } from '../../globals';
import { defineOpenAICompatibleProvider } from '../open-ai-base/define';

// FlexAI serves open-weight models behind an OpenAI-compatible API. Each
// exclusion below was checked against https://api.flex.ai/v1, which rejects the
// parameter outright rather than ignoring it.
//
// `n` is forwarded on chat: FlexAI answers `n > 1` with a readable 400 ("'n'
// must be 1"), which is the caller's to see. `logit_bias` is forwarded too —
// whether it is taken depends on the model, and the ones that refuse it say so.
const FlexAIConfig = defineOpenAICompatibleProvider({
  name: FLEXAI,
  baseURL: 'https://api.flex.ai',
  endpoints: {
    chatComplete: {
      path: '/v1/chat/completions',
      defaultModel: 'DeepSeek-V4-Flash-0731',
      // Rejected with an unexplained "Invalid request.", so it is not sent.
      exclude: ['verbosity'],
    },
    complete: {
      path: '/v1/completions',
      defaultModel: 'DeepSeek-V4-Flash-0731',
      exclude: ['suffix'],
    },
    embed: {
      path: '/v1/embeddings',
      defaultModel: 'bge-m3',
      // bge-m3 has a fixed 1024-dimension output; `dimensions` is rejected.
      exclude: ['dimensions'],
    },
  },
});

export default FlexAIConfig;
