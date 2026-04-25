// Providers encode errors in error.message as JSON. This paired throw is
// designed to be caught by parseProviderErrorResponse, which parses that JSON.
export const throwIfNotOk = async (response: Response, provider: string): Promise<void> => {
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      JSON.stringify({
        type: 'provider_error',
        code: response.status,
        param: null,
        message: `${provider} error: ${errorText}`,
      }),
    );
  }
};
