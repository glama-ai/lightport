import { ProviderAPIConfig } from '../types';

const TritonAPIConfig: ProviderAPIConfig = {
  headers: () => {
    return {};
  },
  getBaseURL: ({ providerOptions }) => {
    return providerOptions.customHost ?? '';
  },
  getEndpoint: ({ fn }) => {
    switch (fn) {
      case 'complete':
        return `/generate`;
      default:
        return '';
    }
  },
};

export default TritonAPIConfig;
