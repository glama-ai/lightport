import { POWERED_BY, REQUESTY } from '../../globals';
import { defineOpenAICompatibleProvider } from '../open-ai-base/define';
import { RequestyChatCompleteResponseTransform } from './chatComplete';

const RequestyConfig = defineOpenAICompatibleProvider({
  name: REQUESTY,
  baseURL: 'https://router.requesty.ai',
  headers: () => ({
    // Requesty reads these to attribute a request in its own dashboard. They
    // are optional there, and named as OpenRouter names them.
    'HTTP-Referer': 'https://lightport.ai/',
    'X-Title': POWERED_BY,
  }),
  endpoints: {
    // Requesty reads OpenAI's parameters under their own names,
    // `reasoning_effort` among them, so nothing is excluded. Its models are
    // named for the house that made them, so a request that names none has to
    // be given one that is.
    chatComplete: { path: '/v1/chat/completions', defaultModel: 'openai/gpt-4o-mini' },
  },
});

export default {
  ...RequestyConfig,
  responseTransforms: { chatComplete: RequestyChatCompleteResponseTransform },
};
