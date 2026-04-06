# TL Codex Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** TL를 Codex local plugin/MCP tool로 노출해서 Codex가 `tl status`, 세션 조회/재개, daemon 제어, config get/set을 직접 실행할 수 있게 만든다.

**Architecture:** TL npm 패키지 안에 `plugins/tl-tools` plugin 자산을 포함하고, 전역 설치된 TL package의 `dist/tl-mcp-server.js`를 stdio MCP server로 사용한다. `tl plugin install` 명령은 home-local plugin 설치(`~/plugins/tl-tools`)와 `~/.agents/plugins/marketplace.json` 등록을 자동화하고, plugin server는 TL CLI를 안전한 allowlist 기반 tool로 감싼다.

**Tech Stack:** TypeScript, Node.js, `@modelcontextprotocol/sdk`, TL CLI, Vitest

---

## File Structure

- Create: `plugins/tl-tools/.codex-plugin/plugin.json`
- Create: `plugins/tl-tools/.mcp.json.template`
- Create: `src/plugin-installer.ts`
- Create: `src/tl-mcp-tools.ts`
- Create: `src/tl-mcp-server.ts`
- Modify: `src/cli.ts`
- Modify: `package.json`
- Modify: `README.md`
- Modify: `PROMPTS.md`
- Modify: `CODEX_SETUP.md`
- Test: `tests/plugin-installer.test.ts`
- Test: `tests/tl-mcp-tools.test.ts`

### Task 1: Plugin install surface 추가

**Files:**
- Create: `plugins/tl-tools/.codex-plugin/plugin.json`
- Create: `plugins/tl-tools/.mcp.json.template`
- Create: `src/plugin-installer.ts`
- Modify: `src/cli.ts`
- Test: `tests/plugin-installer.test.ts`

- [x] **Step 1: plugin install 요구사항을 고정하는 failing test 작성**

```ts
it('installs tl-tools plugin into ~/plugins and registers marketplace entry', async () => {
  const installer = new PluginInstaller({
    homeDir,
    pluginSourceDir,
    nodeBinary: '/usr/local/bin/node',
    cliScriptPath: '/usr/local/lib/node_modules/tl-codex-bridge/dist/cli.js',
    mcpServerPath: '/usr/local/lib/node_modules/tl-codex-bridge/dist/tl-mcp-server.js',
  });

  const result = await installer.install();

  expect(result.pluginPath).toBe(path.join(homeDir, 'plugins', 'tl-tools'));
  expect(readJson(path.join(homeDir, '.agents/plugins/marketplace.json'))).toEqual({
    name: 'local',
    interface: { displayName: 'Local Plugins' },
    plugins: expect.arrayContaining([
      expect.objectContaining({
        name: 'tl-tools',
        source: { source: 'local', path: './plugins/tl-tools' },
      }),
    ]),
  });
});
```

- [x] **Step 2: test를 실행해서 실패를 확인**

Run: `npm test -- tests/plugin-installer.test.ts`
Expected: FAIL with missing module or missing `PluginInstaller`

- [x] **Step 3: 최소 installer 구현**

```ts
export class PluginInstaller {
  async install(): Promise<{ pluginPath: string; marketplacePath: string }> {
    await fs.promises.mkdir(pluginPath, { recursive: true });
    await copyPluginAssets();
    await writeMcpConfig({
      nodeBinary: this.nodeBinary,
      mcpServerPath: this.mcpServerPath,
      cliScriptPath: this.cliScriptPath,
    });
    await upsertMarketplaceEntry();
    return { pluginPath, marketplacePath };
  }
}
```

- [x] **Step 4: CLI 진입점 연결**

```ts
case 'plugin':
  return cmdPlugin(args);
```

```ts
async function cmdPlugin(args: string[]) {
  const subcommand = args[0];
  if (subcommand === 'install') {
    const installer = createPluginInstaller();
    const result = await installer.install();
    console.log(`TL plugin installed at ${result.pluginPath}`);
    return;
  }

  console.log('Usage: tl plugin install | tl plugin status');
}
```

- [x] **Step 5: 테스트 재실행**

Run: `npm test -- tests/plugin-installer.test.ts`
Expected: PASS

### Task 2: TL MCP tool handlers 구현

**Files:**
- Create: `src/tl-mcp-tools.ts`
- Create: `src/tl-mcp-server.ts`
- Modify: `package.json`
- Test: `tests/tl-mcp-tools.test.ts`

- [x] **Step 1: tool handler failing test 작성**

```ts
it('validates tl_set_config keys and forwards allowed writes to tl config set', async () => {
  const runner = vi.fn().mockResolvedValue({
    code: 0,
    stdout: 'Config saved\n',
    stderr: '',
  });

  const tools = createTlMcpTools({ runTlCommand: runner });
  await tools.call('tl_set_config', {
    values: {
      groupId: -1001234567890,
      stopTimeout: 7200,
      liveStream: false,
    },
  });

  expect(runner).toHaveBeenCalledWith([
    'config',
    'set',
    'groupId=-1001234567890',
    'stopTimeout=7200',
    'liveStream=false',
  ]);
});
```

- [x] **Step 2: MCP SDK 의존성 추가 후 테스트 실패 확인**

Run: `npm test -- tests/tl-mcp-tools.test.ts`
Expected: FAIL with missing `createTlMcpTools`

- [x] **Step 3: tool registry 구현**

```ts
export function createTlMcpTools(deps: TlMcpToolDeps) {
  return {
    definitions: [
      { name: 'tl_status', inputSchema: { type: 'object', properties: {} } },
      { name: 'tl_list_sessions', inputSchema: { type: 'object', properties: { status: { type: 'string' } } } },
      { name: 'tl_resume_session', inputSchema: { type: 'object', required: ['sessionId'], properties: { sessionId: { type: 'string' } } } },
      { name: 'tl_start_daemon', inputSchema: { type: 'object', properties: {} } },
      { name: 'tl_stop_daemon', inputSchema: { type: 'object', properties: {} } },
      { name: 'tl_get_config', inputSchema: { type: 'object', properties: { key: { type: 'string' } } } },
      { name: 'tl_set_config', inputSchema: { type: 'object', required: ['values'], properties: { values: { type: 'object' } } } },
    ],
    async call(name, args) {
      // dispatch + allowlist validation
    },
  };
}
```

- [x] **Step 4: stdio MCP server 구현**

```ts
const server = new Server(
  { name: 'tl-tools', version: '0.1.0' },
  { capabilities: { tools: {} } }
);

for (const tool of tools.definitions) {
  server.tool(tool.name, tool.inputSchema, async (args) => tools.call(tool.name, args));
}

await server.connect(new StdioServerTransport());
```

- [x] **Step 5: 테스트 재실행**

Run: `npm test -- tests/tl-mcp-tools.test.ts`
Expected: PASS

### Task 3: 설치 후 사용자 UX 마감

**Files:**
- Modify: `src/cli.ts`
- Modify: `README.md`
- Modify: `PROMPTS.md`
- Modify: `CODEX_SETUP.md`

- [x] **Step 1: plugin status/repair 경로 추가**

```ts
if (subcommand === 'status') {
  const status = await installer.status();
  console.log(JSON.stringify(status, null, 2));
  return;
}
```

- [x] **Step 2: README에 plugin 기능/설치/확인 추가**

```md
## Codex Plugin

TL은 optional local Codex plugin을 제공한다.

```bash
tl plugin install
tl plugin status
```

설치 후 Codex에서 TL tool을 직접 사용할 수 있다:
- `tl_status`
- `tl_list_sessions`
- `tl_resume_session`
- `tl_start_daemon`
- `tl_stop_daemon`
- `tl_get_config`
- `tl_set_config`
```

- [x] **Step 3: PROMPTS.md와 CODEX_SETUP.md에 plugin 자동 설치 프롬프트 추가**

```text
Install TL from https://github.com/flowkater/tl, run tl plugin install, verify tl plugin status, and make sure the local Codex marketplace entry for tl-tools exists before reporting completion.
```

- [x] **Step 4: 문서 lint 성격 확인**

Run: `rg -n "tl plugin install|tl_status|tl_set_config" README.md PROMPTS.md CODEX_SETUP.md`
Expected: All docs contain current plugin workflow

### Task 4: 전체 검증 및 커밋

**Files:**
- Modify: `package.json`
- Modify: created/updated files from Tasks 1-3

- [x] **Step 1: 전체 빌드**

Run: `npm run build`
Expected: PASS

- [x] **Step 2: 전체 테스트**

Run: `npm test`
Expected: PASS with updated total test count

- [x] **Step 3: 로컬 smoke test**

Run:

```bash
tl plugin install
tl plugin status
```

Expected:
- plugin path 출력
- marketplace entry 확인
- generated `.mcp.json`에 absolute `node`/`dist/tl-mcp-server.js`/`dist/cli.js` 경로 포함

- [x] **Step 4: 커밋**

```bash
git add package.json package-lock.json src plugins tests README.md PROMPTS.md CODEX_SETUP.md docs/superpowers/plans/2026-04-06-tl-codex-plugin.md
git commit -m "feat: add local Codex plugin for TL"
```

## Self-Review

- Spec coverage: plugin 자산, MCP server, CLI installer, 문서, 검증 경로를 모두 task로 포함했다.
- Placeholder scan: 남은 TODO/TBD 없음.
- Type consistency: tool 이름은 `tl_status`, `tl_list_sessions`, `tl_resume_session`, `tl_start_daemon`, `tl_stop_daemon`, `tl_get_config`, `tl_set_config`로 통일했다.
