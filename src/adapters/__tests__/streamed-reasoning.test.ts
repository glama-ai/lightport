import { describe, expect, it } from 'vitest';
import {
  transformStreamChunk as transformMessagesChunk,
  createStreamState as createMessagesState,
} from '../messages/streamTransform';
import {
  transformStreamChunk as transformResponsesChunk,
  createStreamState as createResponsesState,
} from '../responses/streamTransform';

const chunk = (delta: Record<string, unknown>, finishReason: string | null = null) =>
  `data: ${JSON.stringify({
    id: 'chat-1',
    object: 'chat.completion.chunk',
    created: 1_700_000_000,
    model: 'a-reasoner',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}`;

const events = (out: string) =>
  out
    .split('\n\n')
    .filter(Boolean)
    .map((block) => {
      const [eventLine, dataLine] = block.split('\n');
      return {
        event: eventLine.replace(/^event: /, ''),
        data: dataLine ? JSON.parse(dataLine.replace(/^data: /, '')) : null,
      };
    });

describe('the Messages adapter streaming a reasoner', () => {
  const run = (deltas: Record<string, unknown>[]) => {
    const state = createMessagesState();
    const out = deltas
      .map((d, i) =>
        transformMessagesChunk(chunk(d, i === deltas.length - 1 ? 'stop' : null), state),
      )
      .filter(Boolean)
      .join('');

    return events(out);
  };

  it('carries the thinking a provider streams as reasoning_content', () => {
    // This adapter read no reasoning at all, so a streamed reasoner arrived here
    // with its thinking missing while the non-streaming half kept it.
    const all = run([{ role: 'assistant', reasoning_content: 'two plus' }, { content: 'four' }]);

    expect(all).toContainEqual({
      event: 'content_block_delta',
      data: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: 'two plus' },
      },
    });
  });

  it('carries it from content_blocks too', () => {
    const all = run([
      { role: 'assistant', content_blocks: [{ delta: { thinking: 'two plus' } }] },
      { content: 'four' },
    ]);

    expect(all.some((e) => e.data?.delta?.type === 'thinking_delta')).toBe(true);
  });

  it('counts the reasoning once when a provider sends it both ways', () => {
    // Together streams both, and an adapter always runs with compliance relaxed.
    const all = run([
      {
        role: 'assistant',
        reasoning_content: 'two plus',
        content_blocks: [{ delta: { thinking: 'two plus' } }],
      },
      { content: 'four' },
    ]);

    const thinking = all
      .filter((e) => e.data?.delta?.type === 'thinking_delta')
      .map((e) => e.data.delta.thinking);

    expect(thinking).toEqual(['two plus']);
  });

  it('opens the thinking before the answer and closes it first', () => {
    // Anthropic orders the thinking ahead of the answer, and the non-streaming
    // half of this adapter already did.
    const all = run([{ role: 'assistant', reasoning_content: 'two plus' }, { content: 'four' }]);
    const starts = all.filter((e) => e.event === 'content_block_start');

    expect(starts.map((e) => e.data.content_block.type)).toEqual(['thinking', 'text']);
    expect(starts.map((e) => e.data.index)).toEqual([0, 1]);

    const order = all.map((e) => `${e.event}:${e.data?.index}`);
    expect(order.indexOf('content_block_stop:0')).toBeLessThan(
      order.indexOf('content_block_start:1'),
    );
  });

  it('closes every block it opened, including the tool calls', () => {
    // Only index 0 was ever closed, so a tool_use block was left open.
    const all = run([
      { role: 'assistant', content: 'calling' },
      { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'f', arguments: '{}' } }] },
    ]);

    const opened = all.filter((e) => e.event === 'content_block_start').map((e) => e.data.index);
    const closed = all.filter((e) => e.event === 'content_block_stop').map((e) => e.data.index);

    expect(opened.length).toBeGreaterThan(1);
    expect(closed.sort()).toEqual(opened.sort());
  });

  it('gives the model a fresh block when it thinks again after answering', () => {
    // The thinking block is closed once the answer starts, so continuing to
    // write into it would put a delta after that block's own stop.
    const all = run([
      { role: 'assistant', reasoning_content: 'first', content: 'a' },
      { reasoning_content: 'second' },
      { content: 'b' },
    ]);

    const starts = all.filter((e) => e.event === 'content_block_start');
    expect(starts.map((e) => e.data.content_block.type)).toEqual([
      'thinking',
      'text',
      'thinking',
      'text',
    ]);

    // No delta may follow the stop of the block it belongs to.
    const closed = new Set<number>();
    for (const e of all) {
      if (e.event === 'content_block_stop') closed.add(e.data.index);
      if (e.event === 'content_block_delta') expect(closed.has(e.data.index)).toBe(false);
    }
  });

  it('never opens a block inside another', () => {
    // Including between two tool calls and either side of them, which is where
    // the blocks used to be left open and nested.
    const all = run([
      { role: 'assistant', content: 'part one ' },
      { reasoning_content: 'hmm' },
      { content: 'part two' },
      { tool_calls: [{ index: 0, id: 'a', function: { name: 'f', arguments: '{"x":1}' } }] },
      { tool_calls: [{ index: 1, id: 'b', function: { name: 'g', arguments: '{"y":2}' } }] },
      { content: 'and here is why' },
    ]);

    let open = 0;
    for (const e of all) {
      if (e.event === 'content_block_start') {
        expect(open).toBe(0);
        open++;
      }
      if (e.event === 'content_block_stop') open--;
    }
    expect(open).toBe(0);
  });

  it('stops writing into its blocks once the message has finished', () => {
    // A provider repeating the finish reason on every chunk kept the adapter
    // writing into blocks it had already closed.
    const state = createMessagesState();
    const out = [
      transformMessagesChunk(chunk({ role: 'assistant', content: 'a' }, 'stop'), state),
      transformMessagesChunk(chunk({ content: 'b' }, 'stop'), state),
      transformMessagesChunk('data: [DONE]', state),
    ]
      .filter(Boolean)
      .join('');

    const closed = new Set<number>();
    for (const e of events(out)) {
      if (e.event === 'content_block_stop') closed.add(e.data.index);
      if (e.event === 'content_block_delta') expect(closed.has(e.data.index)).toBe(false);
    }
  });

  it('keeps one call in one block when the provider repeats the name', () => {
    // A block per chunk would split the arguments into pieces of invalid JSON.
    const all = run([
      {
        role: 'assistant',
        tool_calls: [{ index: 0, id: 'c1', function: { name: 'f', arguments: '{"a' } }],
      },
      { tool_calls: [{ index: 0, id: 'c1', function: { name: 'f', arguments: '":1}' } }] },
    ]);

    const starts = all.filter((e) => e.event === 'content_block_start');
    expect(starts).toHaveLength(1);

    const json = all
      .filter((e) => e.data?.delta?.type === 'input_json_delta')
      .map((e) => e.data.delta.partial_json)
      .join('');
    expect(JSON.parse(json)).toEqual({ a: 1 });
  });

  it('gives two calls sharing an index their own blocks', () => {
    // Some providers number the calls within a chunk from zero, so a second
    // call in a later chunk arrives as index 0 again.
    const all = run([
      {
        role: 'assistant',
        tool_calls: [{ index: 0, id: 'a', function: { name: 'f', arguments: '{}' } }],
      },
      { tool_calls: [{ index: 0, id: 'b', function: { name: 'g', arguments: '{}' } }] },
    ]);

    const starts = all.filter((e) => e.event === 'content_block_start');
    expect(starts.map((e) => e.data.content_block.name)).toEqual(['f', 'g']);
  });

  it('keeps arguments that arrive before the call is named', () => {
    // They were dropped, so the tool ran on an empty input with nothing to say
    // it had been given one.
    const all = run([
      { role: 'assistant', tool_calls: [{ index: 0, function: { arguments: '{"a":1}' } }] },
      { tool_calls: [{ index: 0, id: 'c1', function: { name: 'f' } }] },
    ]);

    const json = all
      .filter((e) => e.data?.delta?.type === 'input_json_delta')
      .map((e) => e.data.delta.partial_json)
      .join('');
    expect(JSON.parse(json)).toEqual({ a: 1 });
  });

  it('closes its blocks when the stream ends without a finish reason', () => {
    const state = createMessagesState();
    const out = [
      transformMessagesChunk(chunk({ role: 'assistant', reasoning_content: 'thinking' }), state),
      transformMessagesChunk(chunk({ content: 'hi' }), state),
      transformMessagesChunk('data: [DONE]', state),
    ]
      .filter(Boolean)
      .join('');

    const all = events(out);
    const opened = all.filter((e) => e.event === 'content_block_start').map((e) => e.data.index);
    const closed = all.filter((e) => e.event === 'content_block_stop').map((e) => e.data.index);

    expect(closed).toEqual(opened);
    // The blocks close before the message does.
    expect(all[all.length - 1].event).toBe('message_stop');
  });

  it('still carries an empty text block for a model that said nothing', () => {
    const all = run([{ role: 'assistant' }]);
    const starts = all.filter((e) => e.event === 'content_block_start');

    expect(starts).toHaveLength(1);
    expect(starts[0].data.content_block).toEqual({ type: 'text', text: '' });
    expect(all.filter((e) => e.event === 'content_block_stop')).toHaveLength(1);
  });
});

describe('the Responses adapter streaming a reasoner', () => {
  const run = (deltas: Record<string, unknown>[]) => {
    const state = createResponsesState();
    const out = deltas
      .map((d) => transformResponsesChunk(chunk(d), state))
      .filter(Boolean)
      .join('');

    return events(out);
  };

  it('carries the thinking a provider streams as reasoning_content', () => {
    // Only `content_blocks` was read, so the providers speaking OpenAI's dialect
    // reached this API with their reasoning dropped.
    const all = run([{ role: 'assistant', reasoning_content: 'two plus' }]);

    expect(all).toContainEqual(
      expect.objectContaining({
        event: 'response.reasoning_summary_text.delta',
        data: expect.objectContaining({ delta: 'two plus' }),
      }),
    );
  });

  it('still carries it from content_blocks', () => {
    const all = run([{ role: 'assistant', content_blocks: [{ delta: { thinking: 'two plus' } }] }]);

    expect(all.some((e) => e.event === 'response.reasoning_summary_text.delta')).toBe(true);
  });

  it('counts the reasoning once when a provider sends it both ways', () => {
    const all = run([
      {
        role: 'assistant',
        reasoning_content: 'two plus',
        content_blocks: [{ delta: { thinking: 'two plus' } }],
      },
    ]);

    const deltas = all
      .filter((e) => e.event === 'response.reasoning_summary_text.delta')
      .map((e) => e.data.delta);

    expect(deltas).toEqual(['two plus']);
  });

  it('opens the reasoning item once across many chunks', () => {
    const all = run([
      { role: 'assistant', reasoning_content: 'two ' },
      { reasoning_content: 'plus two' },
    ]);

    const added = all.filter(
      (e) => e.event === 'response.output_item.added' && e.data.item?.type === 'reasoning',
    );

    expect(added).toHaveLength(1);
    expect(
      all
        .filter((e) => e.event === 'response.reasoning_summary_text.delta')
        .map((e) => e.data.delta),
    ).toEqual(['two ', 'plus two']);
  });
});
