import { MODAL } from '../../globals';
import { defineOpenAICompatibleProvider } from '../open-ai-base/define';

// Modal serves one deployment per host, so the base URL here is a placeholder a
// caller is expected to replace with `x-lightport-custom-host`. With no API key
// it reads `model-key` and `model-secret` from the forwarded headers instead,
// which is why no bearer is sent when there is none to send.
const ModalConfig = defineOpenAICompatibleProvider({
  name: MODAL,
  baseURL: 'https://api.modal.com',
  endpoints: {
    // Text completions are left out rather than assumed: the parameters were
    // registered before without a path to send them to, so the request went to
    // the bare base URL. Refusing it by name says more than that did.
    chatComplete: { path: '/v1/chat/completions', defaultModel: null },
  },
});

export default ModalConfig;
