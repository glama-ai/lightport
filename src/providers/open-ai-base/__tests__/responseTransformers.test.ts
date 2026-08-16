import { describe, expect, it } from 'vitest';
import { responseTransformers } from '..';

const chatComplete = (provider = 'testprovider') =>
  responseTransformers(provider, { chatComplete: true }).chatComplete as (
    response: unknown,
    status: number,
  ) => any;

describe('a failure the provider did not write in OpenAI shape', () => {
  // Every one of these reached the caller as the upstream wrote it, and an
  // OpenAI client reads `error.message` off each and finds `undefined`. The
  // request failed for a stated reason and arrived carrying no reason at all.
  it('names a FastAPI detail string', () => {
    const answer = chatComplete()({ detail: 'Not Found' }, 404);

    expect(answer.error.message).toBe('testprovider error: Not Found');
    expect(answer.provider).toBe('testprovider');
  });

  it('names the field a FastAPI validation list points at', () => {
    const answer = chatComplete()(
      {
        detail: [{ loc: ['body', 'model'], msg: 'field required', type: 'value_error.missing' }],
      },
      422,
    );

    expect(answer.error.message).toBe('testprovider error: body.model: field required');
    expect(answer.error.type).toBe('value_error.missing');
  });

  it('names an error reported as a bare string', () => {
    const answer = chatComplete()({ error: 'no api key', code: 'missing_api_key' }, 401);

    expect(answer.error.message).toBe('testprovider error: no api key');
    expect(answer.error.code).toBe('missing_api_key');
  });

  it('reports an error object that names no message', () => {
    const answer = chatComplete()({ error: { code: 'nope' } }, 400);

    // Better the whole body than the word `undefined`, which is what spreading
    // a messageless error produced.
    expect(answer.error.message).toContain('nope');
  });

  it('reports a shape it cannot name rather than dropping it', () => {
    const answer = chatComplete()({ something: 'unexpected' }, 500);

    expect(answer.error.message).toContain('unexpected');
  });

  it('keeps handling the OpenAI shape it always did', () => {
    const answer = chatComplete()(
      { error: { message: 'over quota', type: 'insufficient_quota', param: null, code: '429' } },
      429,
    );

    expect(answer.error).toEqual({
      message: 'testprovider error: over quota',
      type: 'insufficient_quota',
      param: null,
      code: '429',
    });
  });
});

describe('a body the provider mislabelled as text', () => {
  // Railway, Cloudflare and every other edge in front of an API answer 502 with
  // an HTML page. It arrives wrapped under `html-message`, and the chat path
  // was the one path with no branch for it.
  it('reports an HTML error page as an error', () => {
    const answer = chatComplete()({ 'html-message': '<html>502 Bad Gateway</html>' }, 502);

    expect(answer.error.message).toBe('testprovider error: <html>502 Bad Gateway</html>');
  });

  it('reads a JSON failure that arrived wrapped', () => {
    const answer = chatComplete()(
      { 'html-message': JSON.stringify({ error: { message: 'bad key' } }) },
      401,
    );

    expect(answer.error.message).toBe('testprovider error: bad key');
  });

  it('hands back the answer inside, when it was an answer all along', () => {
    // OpenAI answers some requests with `content-type: text/plain` over a body
    // that is JSON. The answer is in there; nothing but the label was wrong.
    const answer = chatComplete()(
      { 'html-message': JSON.stringify({ id: 'chatcmpl-1', choices: [] }) },
      200,
    );

    expect(answer.id).toBe('chatcmpl-1');
    expect(answer.provider).toBe('testprovider');
  });
});

describe('an answer', () => {
  it('is carried whole, named with the provider that gave it', () => {
    const body = { id: 'chatcmpl-1', choices: [{ message: { content: 'hi' } }], usage: { a: 1 } };
    const answer = chatComplete()(body, 200);

    expect(answer).toMatchObject(body);
    expect(answer.provider).toBe('testprovider');
  });
});

describe('a provider that brought its own transformer', () => {
  // It exists because that provider's shape is its own — `x-ai` reads an error
  // reported as a bare string. Handing it a reshaped envelope would take away
  // the very thing it was written to read.
  it('is handed the failure as the provider wrote it', () => {
    const seen: unknown[] = [];
    const transforms = responseTransformers('testprovider', {
      chatComplete: (response, isError) => {
        seen.push({ response, isError });
        return response as any;
      },
    });

    (transforms.chatComplete as any)({ detail: 'Not Found' }, 404);

    expect(seen).toEqual([{ response: { detail: 'Not Found' }, isError: true }]);
  });

  it('is used on the speech path too, which built a failure and returned the body', () => {
    const transforms = responseTransformers('testprovider', { createSpeech: true });
    const answer = (transforms.createSpeech as any)({ detail: 'nope' }, 400);

    expect(answer.error.message).toBe('testprovider error: nope');
  });

  it('is used on the embed path too, which ignored it entirely', () => {
    const seen: unknown[] = [];
    const transforms = responseTransformers('testprovider', {
      embed: (response, isError) => {
        seen.push(isError);
        return response as any;
      },
    });

    (transforms.embed as any)({ error: { message: 'nope' } }, 400);

    expect(seen).toEqual([true]);
  });
});
