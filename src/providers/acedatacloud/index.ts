import { defineOpenAICompatibleProvider } from '../open-ai-base/define';

/** Ace Data Cloud's chat endpoint, using the caller's own API credential. */
const AceDataCloudConfig = defineOpenAICompatibleProvider({
  name: 'acedatacloud',
  baseURL: 'https://api.acedata.cloud',
  endpoints: {
    // A model must be chosen by the caller; do not silently select a paid model.
    chatComplete: { path: '/openai/chat/completions', defaultModel: null },
  },
});

export default AceDataCloudConfig;
