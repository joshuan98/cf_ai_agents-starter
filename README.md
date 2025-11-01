# 🤖 cf_ai_agents-starter - Chat Agent Starter Kit

![npm i agents command](./npm-agents-banner.svg)

<a href="https://deploy.workers.cloudflare.com/?url=https://github.com/cloudflare/agents-starter"><img src="https://deploy.workers.cloudflare.com/button" alt="Deploy to Cloudflare"/></a>

A production-ready starter template for building AI-powered chat agents using Cloudflare's Agent platform, powered by [`agents`](https://www.npmjs.com/package/agents). This project provides a complete foundation for creating interactive chat experiences with AI, featuring a modern React UI, intelligent tool integration, and flexible task scheduling capabilities.

> **Note**: This repository should be renamed to `cf_ai_agents-starter` to meet submission requirements. The prefix `cf_ai_` is required for consideration.

## ✨ Features

- 💬 **Interactive chat interface** with real-time AI responses
- 🛠️ **Built-in tool system** with human-in-the-loop confirmation
- 📅 **Advanced task scheduling** (one-time, delayed, and recurring via cron)
- 🌓 **Dark/Light theme support** with smooth transitions
- ⚡️ **Real-time streaming responses** using AI SDK
- 🔄 **State management** and persistent chat history
- 🎨 **Modern, responsive UI** built with React and Tailwind CSS
- 🔌 **MCP (Model Context Protocol) integration** for extensible tool support
- 🧩 **Modular architecture** for easy customization
- 📱 **Mobile-friendly** responsive design

## 🎯 What Makes This Project Unique

This starter kit demonstrates several advanced patterns for building production-ready AI agents:

1. **Human-in-the-Loop Pattern**: Tools can require user confirmation before execution, perfect for sensitive operations like data modification or external API calls.

2. **Flexible Task Scheduling**: Supports three scheduling modes:
   - One-time scheduled tasks (specific date/time)
   - Delayed execution (run after X seconds)
   - Recurring tasks (cron patterns)

3. **Clean Architecture**: Separates concerns with clear boundaries between:
   - Agent logic (server.ts)
   - Tool definitions (tools.ts)
   - UI components (app.tsx and components/)
   - Utilities (utils.ts)

4. **Type-Safe Tool System**: Leverages TypeScript and Zod for runtime validation and compile-time safety.

5. **Production-Ready**: Includes testing, linting, formatting, and deployment configurations.

## 📋 Prerequisites

- Cloudflare account
- OpenAI API key

## 🚀 Quick Start

### Option 1: Try the Live Demo

Visit the deployed application at: https://ai-conversation-app.joshuanee98.workers.dev/

### Option 2: Run Locally

1. **Clone or create the project:**

   ```bash
   # Using the Cloudflare template
   npx create-cloudflare@latest --template cloudflare/agents-starter

   # Or clone this repository
   git clone https://github.com/your-username/cf_ai_agents-starter.git
   cd cf_ai_agents-starter
   ```

2. **Install dependencies:**

   ```bash
   npm install
   ```

3. **Configure your environment:**

   Create a `.dev.vars` file in the root directory with your OpenAI API key:

   ```env
   OPENAI_API_KEY=sk-your-actual-openai-api-key-here
   ```

   > **Important**: Never commit `.dev.vars` to version control. This file is already in `.gitignore`.

4. **Start the development server:**

   ```bash
   npm start
   ```

   The application will be available at `http://localhost:5173` (or another port if 5173 is in use).

5. **Start chatting!**
   - Type messages in the chat interface
   - Try asking the AI to check the weather, get the time, or schedule tasks
   - Confirm tool executions when prompted
   - Toggle between light and dark themes

### Option 3: Deploy to Cloudflare Workers

1. **Build the project:**

   ```bash
   npm run deploy
   ```

2. **Set production secrets:**

   ```bash
   wrangler secret bulk .dev.vars
   ```

   This uploads your API keys securely to Cloudflare Workers.

3. **Access your deployed agent:**

   After deployment, Wrangler will provide a URL like `https://your-agent.workers.dev`

## 📁 Project Structure

```
cf_ai_agents-starter/
├── src/
│   ├── app.tsx                 # Main chat UI component
│   ├── server.ts               # Chat agent implementation (extends AIChatAgent)
│   ├── tools.ts                # Tool definitions (weather, time, scheduling)
│   ├── utils.ts                # Helper functions for message processing
│   ├── client.tsx              # Client-side entry point
│   ├── styles.css              # Global styles and theme variables
│   ├── components/             # Reusable UI components
│   │   ├── avatar/             # User/Assistant avatars
│   │   ├── button/             # Button components
│   │   ├── card/               # Card layouts
│   │   ├── input/              # Input fields
│   │   ├── modal/              # Modal dialogs
│   │   ├── tool-invocation-card/ # Tool confirmation UI
│   │   └── ...
│   ├── hooks/                  # Custom React hooks
│   │   ├── useTheme.ts         # Theme management
│   │   ├── useClickOutside.tsx # Outside click detection
│   │   └── useMenuNavigation.tsx # Keyboard navigation
│   ├── providers/              # React context providers
│   │   ├── ModalProvider.tsx   # Modal state management
│   │   └── TooltipProvider.tsx # Tooltip functionality
│   └── lib/
│       └── utils.ts            # Shared utility functions
├── public/                     # Static assets
├── tests/                      # Test files
├── .dev.vars                   # Local environment variables (not committed)
├── package.json                # Dependencies and scripts
├── tsconfig.json               # TypeScript configuration
├── vite.config.ts              # Vite bundler configuration
├── wrangler.jsonc              # Cloudflare Workers configuration
├── README.md                   # This file
└── PROMPTS.md                  # AI prompts used in development
```

## Customization Guide

### Adding New Tools

Add new tools in `tools.ts` using the tool builder:

```ts
// Example of a tool that requires confirmation
const searchDatabase = tool({
  description: "Search the database for user records",
  parameters: z.object({
    query: z.string(),
    limit: z.number().optional()
  })
  // No execute function = requires confirmation
});

// Example of an auto-executing tool
const getCurrentTime = tool({
  description: "Get current server time",
  parameters: z.object({}),
  execute: async () => new Date().toISOString()
});

// Scheduling tool implementation
const scheduleTask = tool({
  description:
    "schedule a task to be executed at a later time. 'when' can be a date, a delay in seconds, or a cron pattern.",
  parameters: z.object({
    type: z.enum(["scheduled", "delayed", "cron"]),
    when: z.union([z.number(), z.string()]),
    payload: z.string()
  }),
  execute: async ({ type, when, payload }) => {
    // ... see the implementation in tools.ts
  }
});
```

To handle tool confirmations, add execution functions to the `executions` object:

```typescript
export const executions = {
  searchDatabase: async ({
    query,
    limit
  }: {
    query: string;
    limit?: number;
  }) => {
    // Implementation for when the tool is confirmed
    const results = await db.search(query, limit);
    return results;
  }
  // Add more execution handlers for other tools that require confirmation
};
```

Tools can be configured in two ways:

1. With an `execute` function for automatic execution
2. Without an `execute` function, requiring confirmation and using the `executions` object to handle the confirmed action. NOTE: The keys in `executions` should match `toolsRequiringConfirmation` in `app.tsx`.

### Use a different AI model provider

The starting [`server.ts`](https://github.com/cloudflare/agents-starter/blob/main/src/server.ts) implementation uses the [`ai-sdk`](https://sdk.vercel.ai/docs/introduction) and the [OpenAI provider](https://sdk.vercel.ai/providers/ai-sdk-providers/openai), but you can use any AI model provider by:

1. Installing an alternative AI provider for the `ai-sdk`, such as the [`workers-ai-provider`](https://sdk.vercel.ai/providers/community-providers/cloudflare-workers-ai) or [`anthropic`](https://sdk.vercel.ai/providers/ai-sdk-providers/anthropic) provider:
2. Replacing the AI SDK with the [OpenAI SDK](https://github.com/openai/openai-node)
3. Using the Cloudflare [Workers AI + AI Gateway](https://developers.cloudflare.com/ai-gateway/providers/workersai/#workers-binding) binding API directly

For example, to use the [`workers-ai-provider`](https://sdk.vercel.ai/providers/community-providers/cloudflare-workers-ai), install the package:

```sh
npm install workers-ai-provider
```

Add an `ai` binding to `wrangler.jsonc`:

```jsonc
// rest of file
  "ai": {
    "binding": "AI"
  }
// rest of file
```

Replace the `@ai-sdk/openai` import and usage with the `workers-ai-provider`:

```diff
// server.ts
// Change the imports
- import { openai } from "@ai-sdk/openai";
+ import { createWorkersAI } from 'workers-ai-provider';

// Create a Workers AI instance
+ const workersai = createWorkersAI({ binding: env.AI });

// Use it when calling the streamText method (or other methods)
// from the ai-sdk
- const model = openai("gpt-4o-2024-11-20");
+ const model = workersai("@cf/deepseek-ai/deepseek-r1-distill-qwen-32b")
```

Commit your changes and then run the `agents-starter` as per the rest of this README.

### Modifying the UI

The chat interface is built with React and can be customized in `app.tsx`:

- Modify the theme colors in `styles.css`
- Add new UI components in the chat container
- Customize message rendering and tool confirmation dialogs
- Add new controls to the header

### Example Use Cases

1. **Customer Support Agent**
   - Add tools for:
     - Ticket creation/lookup
     - Order status checking
     - Product recommendations
     - FAQ database search

2. **Development Assistant**
   - Integrate tools for:
     - Code linting
     - Git operations
     - Documentation search
     - Dependency checking

3. **Data Analysis Assistant**
   - Build tools for:
     - Database querying
     - Data visualization
     - Statistical analysis
     - Report generation

4. **Personal Productivity Assistant**
   - Implement tools for:
     - Task scheduling with flexible timing options
     - One-time, delayed, and recurring task management
     - Task tracking with reminders
     - Email drafting
     - Note taking

5. **Scheduling Assistant**
   - Build tools for:
     - One-time event scheduling using specific dates
     - Delayed task execution (e.g., "remind me in 30 minutes")
     - Recurring tasks using cron patterns
     - Task payload management
     - Flexible scheduling patterns

Each use case can be implemented by:

1. Adding relevant tools in `tools.ts`
2. Customizing the UI for specific interactions
3. Extending the agent's capabilities in `server.ts`
4. Adding any necessary external API integrations

## 🧪 Testing

Run the test suite:

```bash
npm test
```

Run type checking:

```bash
npm run check
```

Format code:

```bash
npm run format
```

## 📝 Available Scripts

- `npm start` - Start local development server
- `npm run deploy` - Build and deploy to Cloudflare Workers
- `npm test` - Run tests with Vitest
- `npm run types` - Generate TypeScript types for Cloudflare bindings
- `npm run format` - Format code with Prettier
- `npm run check` - Run Prettier, Biome linting, and TypeScript checks

## 🔧 Troubleshooting

### "OPENAI_API_KEY is not set" error

- Make sure you created the `.dev.vars` file in the project root
- Verify the API key is valid and not expired
- For production, ensure you ran `wrangler secret bulk .dev.vars`

### Port already in use

- Vite will automatically try the next available port
- Or manually specify a port: `npm start -- --port 3000`

### Build errors

- Clear node_modules and reinstall: `rm -rf node_modules && npm install`
- Update dependencies: `npm update`
- Check Node.js version (requires Node 18+)

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## 📚 Learn More

- [`agents` npm package](https://github.com/cloudflare/agents/blob/main/packages/agents/README.md)
- [Cloudflare Agents Documentation](https://developers.cloudflare.com/agents/)
- [Cloudflare Workers Documentation](https://developers.cloudflare.com/workers/)
- [AI SDK Documentation](https://sdk.vercel.ai/docs)
- [OpenAI API Documentation](https://platform.openai.com/docs)

## 📋 AI Development

This project was developed with AI assistance. See [PROMPTS.md](./PROMPTS.md) for all AI prompts used during development.

## 📄 License

MIT
