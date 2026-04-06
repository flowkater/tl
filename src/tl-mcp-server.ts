import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { createTlCommandRunner, createTlMcpTools } from './tl-mcp-tools.js';

async function main() {
  const tools = createTlMcpTools({
    runTlCommand: createTlCommandRunner(),
  });

  const server = new Server(
    {
      name: 'tl-tools',
      version: '0.1.0',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.definitions,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      return await tools.call(
        request.params.name,
        (request.params.arguments as Record<string, unknown>) || {}
      );
    } catch (err) {
      return {
        content: [
          {
            type: 'text' as const,
            text: (err as Error).message,
          },
        ],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${(err as Error).message}\n`);
  process.exit(1);
});
