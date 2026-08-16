import { SCX_AI } from '../../globals';
import { defineOpenAICompatibleProvider } from '../open-ai-base/define';

// SCX.ai exposes /v1/completions, but it is aliased to chat: the response is a
// `chat.completion` carrying `message` rather than a `text_completion` carrying
// `text`. Text completions are left out so the shared transformer is not handed
// a shape it cannot read.
const SCXAIConfig = defineOpenAICompatibleProvider({
  name: SCX_AI,
  baseURL: 'https://api.scx.ai',
  endpoints: {
    chatComplete: {
      path: '/v1/chat/completions',
      defaultModel: null,
      exclude: ['logprobs', 'top_logprobs', 'n', 'logit_bias'],
    },
  },
});

export default SCXAIConfig;
