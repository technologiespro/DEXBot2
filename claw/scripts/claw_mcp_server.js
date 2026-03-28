#!/usr/bin/env node

const { getClawToolByName, getClawToolCatalog } = require('../modules/claw_catalog');
const { runClawCommand } = require('../modules/claw_bridge');

function parseArgs(argv) {
  const options = {};

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === '--profile-root' && next) {
      options.profileRoot = next;
      i += 1;
      continue;
    }

    if (arg === '--account' && next) {
      options.accountName = next;
      i += 1;
      continue;
    }

    if (arg === '--runtime' && next) {
      options.runtimeName = next;
      i += 1;
      continue;
    }
  }

  return options;
}

function writeMessage(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}

function success(id, result) {
  writeMessage({
    jsonrpc: '2.0',
    id,
    result
  });
}

function failure(id, code, message, data = undefined) {
  writeMessage({
    jsonrpc: '2.0',
    id,
    error: {
      code,
      message,
      ...(data === undefined ? {} : { data })
    }
  });
}

function listMcpTools() {
  return getClawToolCatalog().map((tool) => ({
    name: tool.toolName,
    description: tool.description,
    inputSchema: tool.inputSchema || {
      type: 'object',
      properties: {},
      additionalProperties: true
    }
  }));
}

async function handleRequest(message, defaults) {
  const { id, method, params } = message;

  switch (method) {
    case 'initialize':
      success(id, {
        protocolVersion: '2024-11-05',
        capabilities: {
          tools: {
            listChanged: false
          }
        },
        serverInfo: {
          name: 'bitshares-claw',
          version: '0.1.0'
        }
      });
      return;

    case 'notifications/initialized':
      return;

    case 'ping':
      success(id, {});
      return;

    case 'tools/list':
      success(id, {
        tools: listMcpTools()
      });
      return;

    case 'tools/call': {
      const tool = getClawToolByName(params?.name);
      if (!tool) {
        failure(id, -32602, `Unknown tool: ${params?.name || '(missing)'}`);
        return;
      }

      try {
        const result = await runClawCommand(tool.command, {
          ...defaults,
          ...(params?.arguments || {})
        });

        success(id, {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2)
            }
          ],
          structuredContent: result
        });
      } catch (error) {
        success(id, {
          content: [
            {
              type: 'text',
              text: error && error.stack ? error.stack : String(error)
            }
          ],
          isError: true
        });
      }
      return;
    }

    default:
      if (id !== undefined) {
        failure(id, -32601, `Method not found: ${method}`);
      }
  }
}

function createMessageParser(onMessage) {
  let buffer = Buffer.alloc(0);
  let queue = Promise.resolve();

  function processBuffer() {
    while (true) {
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) {
        return;
      }

      const headerBlock = buffer.slice(0, headerEnd).toString('utf8');
      const headers = headerBlock.split('\r\n');
      const contentLengthHeader = headers.find((line) => /^content-length:/i.test(line));
      if (!contentLengthHeader) {
        buffer = Buffer.alloc(0);
        return;
      }

      const length = Number(contentLengthHeader.split(':')[1].trim());
      const bodyStart = headerEnd + 4;
      const bodyEnd = bodyStart + length;

      if (buffer.length < bodyEnd) {
        return;
      }

      const body = buffer.slice(bodyStart, bodyEnd).toString('utf8');
      buffer = buffer.slice(bodyEnd);

      let message;
      try {
        message = JSON.parse(body);
      } catch (error) {
        continue;
      }

      queue = queue.then(() => onMessage(message)).catch((error) => {
        process.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`);
      });
    }
  }

  return {
    push(chunk) {
      buffer = Buffer.concat([buffer, chunk]);
      processBuffer();
    }
  };
}

async function main() {
  const defaults = parseArgs(process.argv.slice(2));
  const parser = createMessageParser((message) => handleRequest(message, defaults));

  process.stdin.on('data', (chunk) => parser.push(chunk));
  process.stdin.on('end', () => process.exit(0));
  process.stdin.resume();
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`${err && err.stack ? err.stack : String(err)}\n`);
    process.exit(1);
  });
}
