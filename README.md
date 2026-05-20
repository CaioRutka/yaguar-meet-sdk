# @yaguar/meet

SDK **proprietário** de reuniões com WebRTC e análise por IA. Provê salas, sinalização Socket.IO, gravação server-side e pipeline de análise (Gemini) no server, e primitivas WebRTC (peer connection, mídia, audio recording, speaking detection) no client — tudo agnóstico de framework HTTP/UI.

---

## Propriedade intelectual

> **Código proprietário da Yaguar.**
>
> Este pacote é **fechado** (license `UNLICENSED`). Não pode ser
> compartilhado, distribuído, revendido, sublicenciado ou usado em
> projeto de terceiros **sem autorização expressa por escrito da Yaguar**.
>
> Cópias autorizadas devem manter esta nota e a licença `UNLICENSED`
> no `package.json`.

A origem oficial é o repositório **público** da Yaguar: [github.com/CaioRutka/yaguar-meet-sdk](https://github.com/CaioRutka/yaguar-meet-sdk). O código permanece proprietário (`UNLICENSED`) — visibilidade no GitHub **não** concede direito de uso comercial ou redistribuição. Prefira instalar a partir deste repositório oficial, não de forks não autorizados.

---

## Instalação

O pacote **não está no npm registry**. Instale direto do GitHub (repo público — **HTTPS**, sem chave SSH).

### Via tag (recomendado para produção)

```bash
npm install "github:CaioRutka/yaguar-meet-sdk#v0.1.0"
```

No `package.json` do backend:

```json
"@yaguar/meet": "github:CaioRutka/yaguar-meet-sdk#v0.1.0"
```

Equivalente explícito em HTTPS:

```json
"@yaguar/meet": "git+https://github.com/CaioRutka/yaguar-meet-sdk.git#v0.1.0"
```

### Via commit SHA (reprodutibilidade máxima)

```bash
npm install "github:CaioRutka/yaguar-meet-sdk#<sha-de-7-ou-40-chars>"
```

### Via branch (apenas para desenvolvimento)

```bash
npm install "github:CaioRutka/yaguar-meet-sdk#main"
```

> Em produção: **prefira `tag` ou `commit SHA`** — `main` é móvel e gera builds não-reprodutíveis.

### SSH (opcional)

Se preferir SSH (mesmo em repo público):

```json
"@yaguar/meet": "git+ssh://git@github.com:CaioRutka/yaguar-meet-sdk.git#v0.1.0"
```

### Subpath exports

Após instalar, o pacote expõe três entradas:

```ts
// Node — server (Socket.IO + handlers HTTP + IA + adapter interface)
import { YaguarMeet, GeminiService, type DatabaseAdapter } from '@yaguar/meet/server';

// Browser — WebRTC vanilla (peer connection, media, signaling, recording)
import { MeetingClient } from '@yaguar/meet/client';

// Isomorphic — tipos compartilhados (Room/Meeting/Analysis records, IceServer, etc)
import type { RoomRecord, MeetingAnalysisResult } from '@yaguar/meet/shared';
```

`import { ... } from '@yaguar/meet'` re-exporta o entry server (Node). Em browser use sempre o subpath `/client`.

---

## O que pertence ao SDK vs ao backend/demo

| Responsabilidade | SDK (`@yaguar/meet`) | Backend (demo / consumer) |
|---|---|---|
| Sinalização WebRTC (Socket.IO) | sim — `registerSocketHandlers`, `YaguarMeet.attach` | — |
| Salas, fila de espera, ciclo de meeting | sim — `RoomManager` | — |
| Gravação server-side de áudio | sim — `RecordingSessionManager` | — |
| Cliente WebRTC vanilla | sim — `MeetingClient` + auxiliares | — |
| Análise IA (interface) | sim — `AIService`, `GeminiService` | — |
| **Prompts / rubric / textos de negócio** | NÃO — injetados via config | sim — `config/rubric.ts` |
| **Persistência (impl)** | NÃO — só interface `DatabaseAdapter` | sim — `adapters/{InMemory,Supabase,Mongo}Adapter.ts` |
| **Rotas HTTP (path, auth, CORS)** | NÃO — só handler agnóstico | sim — `routes/meetRoutes.ts` |
| **Env, deploy, transport** | NÃO | sim — `server.ts`, `config/env.ts` |

O SDK **não** lê `process.env`, **não** define rubric/prompts em português ou em qualquer idioma, e **não** importa nenhum provedor de banco. Tudo isso vem do backend via injeção.

---

## Uso mínimo (server)

```ts
import { createServer } from 'http';
import { YaguarMeet, GeminiService } from '@yaguar/meet/server';
import { MyAdapter } from './my-adapter';

const meet = new YaguarMeet({
  adapter: new MyAdapter(),
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  ai: {
    service: new GeminiService({
      apiKey: process.env.GEMINI_API_KEY!,
      transcribePrompt: 'Transcribe this audio in English.',
      buildAnalysisPrompt: (transcript, params) =>
        `Analyze:\n${transcript}\n\nRubric:\n${params.join('\n')}`,
    }),
    parameters: ['Was the conversation polite?', 'Did the host conclude clearly?'],
  },
});

const server = createServer();
meet.attach(server);
server.prependListener('request', (req, res) => {
  void meet.handleHttpRequest(req, res, { prefix: '/api' });
});
server.listen(4000);
```

## Uso mínimo (client / browser)

```ts
import { MeetingClient } from '@yaguar/meet/client';

const meeting = new MeetingClient({
  url: 'http://localhost:4000',
  roomId: 'abc123',
  userId: 'user-42',
  displayName: 'Caio',
});

meeting.on('ready', ({ isHost }) => console.log('joined as', isHost ? 'host' : 'guest'));
meeting.on('remote-stream', ({ socketId, stream }) => attachVideo(socketId, stream));
meeting.on('chat-message', (msg) => renderChat(msg));

await meeting.join();
```

Eventos disponíveis: `ready`, `remote-stream`, `remote-stream-removed`, `peer-joined`, `peer-left`, `chat-message`, `screen-sharing`, `mic-speaking`, `admission-request`, `admission-sync`, `waiting`, `admitted`, `rejected`, `meeting-ended`, `meeting-complete`, `error`.

---

## API REST (registrada por `handleMeetHttp`)

| Método | Rota | Descrição |
|---|---|---|
| GET | `/health` | Saúde |
| POST | `/rooms` | Cria sala |
| GET | `/rooms/:id` | Metadados + contagem |
| GET | `/rooms/:id/meetings` | Histórico |
| GET | `/meetings/mine?userId=` | Reuniões do usuário |
| GET | `/meetings/:id/detail?userId=` | Detalhe + attendees + análise (host) |
| GET | `/meetings/:id` | Registro bruto |
| GET | `/meetings/:id/analysis` | Análise IA |
| POST | `/meetings/:id/schedule-return` | Agendar retorno |
| GET | `/meetings/:id/schedule-returns` | Lista agendamentos |

Eventos Socket.IO principais: `room:join`/`room:leave`/`room:session`, `signal:offer`/`signal:answer`/`signal:ice-candidate`, `chat:message`, `screen:sharing`, `mic:speaking`, `recording:start`/`recording:chunk`/`recording:stop`, `schedule:return`, `meeting:ended`, `meeting:complete`.

---

## Régua de qualidade

```bash
pnpm install
pnpm run typecheck
pnpm run lint
pnpm run test
pnpm run test:coverage
pnpm run build
```

A cobertura de testes atual é **mínima** (smoke tests em `tests/`): cobre `TypedEmitter` e contrato básico do `RoomManager` (com adapter em memória injetado). Cobertura ampliada (sessão/reconnect/erros Gemini, fluxos de admissão na fila) é trabalho em aberto.

Handlers HTTP públicos usam `IncomingMessage`/`ServerResponse` do Node — **sem `any`**.

---

## Build

```bash
pnpm run build
```

Saída em `dist/`:

```
dist/
├── index.{js,cjs,d.ts}          # entry top-level (re-exporta server)
├── server/index.{js,cjs,d.ts}   # platform: node
├── client/index.{js,cjs,d.ts}   # platform: browser
└── shared/index.{js,cjs,d.ts}   # tipos isomórficos
```

`package.json#files` inclui apenas `dist/`. O script `prepare` roda `npm run build` automaticamente ao instalar via Git — não é necessário commitar `dist/`.

---

## Suporte

Equipe Yaguar (canal interno). Issues no repositório privado.
