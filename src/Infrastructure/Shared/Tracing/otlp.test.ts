// oxlint-disable-next-line effecttsgo/node-builtin-import -- test collector listens; HttpClient cannot serve
import { createServer, type IncomingMessage, type Server } from 'node:http';

import { Effect, Layer, ManagedRuntime, Option } from 'effect';
import { expect, test } from 'vitest';

import { makeTracingLayer } from './otlp';

const sampleNamed = Effect.fn('sampleNamed')(function* () {
  yield* Effect.void;
});

const listen = (handler: (req: IncomingMessage, body: Buffer) => void) =>
  Effect.callback<{ server: Server; url: string }>((resume) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
      });
      req.on('end', () => {
        handler(req, Buffer.concat(chunks));
        res.writeHead(200);
        res.end();
      });
    });
    server.once('error', (error) => {
      resume(Effect.die(error));
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        resume(Effect.die(new Error('expected TCP address')));
        return;
      }
      resume(
        Effect.succeed({
          server,
          url: `http://127.0.0.1:${address.port}/v1/traces`,
        })
      );
    });
  });

const close = (server: Server) =>
  Effect.callback<void>((resume) => {
    server.close((error) => {
      resume(error ? Effect.die(error) : Effect.void);
    });
  });

test('makeTracingLayer uses an empty export layer when the trace endpoint is unset', async () => {
  const layer = makeTracingLayer(Option.none());
  expect(layer).toBe(Layer.empty);

  const runtime = ManagedRuntime.make(layer);
  await runtime.runPromise(sampleNamed());
  await runtime.dispose();
});

test('makeTracingLayer exports named spans over OTLP when the trace endpoint is set', async () => {
  const bodies: Buffer[] = [];
  await Effect.runPromise(
    Effect.gen(function* () {
      const { server, url } = yield* listen((_req, body) => {
        bodies.push(body);
      });

      const runtime = ManagedRuntime.make(makeTracingLayer(Option.some(url)));
      yield* Effect.promise(() => runtime.runPromise(sampleNamed()));
      yield* Effect.promise(() => runtime.dispose());
      yield* close(server);
    })
  );

  expect(bodies.length).toBeGreaterThan(0);
  const payload = Buffer.concat(bodies).toString('utf8');
  expect(payload).toContain('sampleNamed');
  expect(payload).toContain('rippls');
});
