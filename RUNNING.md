# TradeBot - Multi-Agent Quant Trading Terminal

A quantitative trading terminal with multi-agent analysis system inspired by Jim Simons / Renaissance Technologies approach. Features self-evaluating agents, paper trading simulation, and real-time market data.

## Quick Start (Local Environment)

### Prerequisites
- Node.js 18+ 
- npm or pnpm

### Installation & Running

```bash
# 1. Clone the repository
git clone https://github.com/Kyugito666/TradeBot.git
cd TradeBot

# 2. Install dependencies
npm install
# or
pnpm install

# 3. Run the development server
npm run dev
# or
pnpm dev

# 4. Open in browser
# Navigate to http://localhost:3000
```

The dashboard will load with **real market data from OKX** (no API key needed for public data). You can immediately:
- View live market signals for BTC, ETH, SOL, etc.
- Run multi-agent analysis on any symbol
- Use paper trading mode to simulate trades

## Architecture Overview

### Multi-Agent Analysis System

The system uses a team of specialized agents, each analyzing different market factors:

| Agent | Category | Function |
|-------|----------|----------|
| `ma_cross` | Trend | Moving average crossover detection |
| `momentum` | Trend | Rate of change momentum analysis |
| `regime` | Macro | Golden/Death cross regime detection |
| `rsi` | Mean Revert | RSI overbought/oversold detection |
| `bollinger` | Mean Revert | Bollinger Band positioning |
| `whale` | Sentiment | Long/short ratio contrarian signals |
| `open_interest` | Volume | Open interest flow analysis |
| `physicist` | Risk | Veto agent for false breakouts/extreme volatility |

### Analysis Pipeline (6 Stages)

The pipeline always completes all 6 stages (never stops at 2/3):

1. **Validate Input** - Check market data availability
2. **Run Agents** - Execute all enabled agents with timeout protection
3. **Aggregate Votes** - Weight-adjusted vote aggregation
4. **Risk Check** - Veto detection from risk agents
5. **Generate Signal** - Consensus calculation with targets
6. **Complete** - Final result with progress tracking

### Self-Evaluation System

Each agent maintains a scorecard and automatically adjusts based on trade outcomes:

- **On Win**: Weight increase, conviction boost
- **On Loss**: Weight decrease, activation gate raised
- **On 3+ Loss Streak**: Team-wide evaluation triggers
- **Underperformance (<35% accuracy)**: Severe penalty applied

All adjustments are transparent and logged in the UI.

## Paper Trading / Dry-Run Mode

**Yes, there IS a dry-run feature!** It's enabled by default for safety.

### How It Works

1. **Enable/Disable**: Toggle in the dashboard header or Agents tab
2. **Configure Balance**: Set your simulated starting balance (default $10,000)
3. **Risk Per Trade**: Set risk percentage (default 2%)
4. **Automatic Execution**: When consensus signal appears, positions open automatically
5. **TP/SL Monitoring**: Positions close when price hits targets
6. **Self-Evaluation**: Trade results feed back to agent learning system

### Settings Location

- Dashboard header shows DRY-RUN MODE banner when active
- Agents tab has full Paper Trading Settings panel
- Click toggle to switch between paper and live modes

## Environment Variables (Optional)

```env
# Point to a remote Go trading engine (optional)
NEXT_PUBLIC_ENGINE_URL=http://localhost:8765

# Override market data API (optional)
MARKET_API_BASE=https://www.okx.com

# Path to agent evolution state file (optional)
AGENT_EVOLUTION_FILE=./agent_evolution.json
```

## Project Structure

```
/
├── app/
│   ├── api/
│   │   ├── agents/
│   │   │   └── analyze/    # Multi-agent analysis endpoint
│   │   │       └── route.ts
│   │   └── market/         # Real-time market data
│   │       └── route.ts
│   ├── layout.tsx
│   └── page.tsx
├── components/
│   ├── analysis-progress.tsx   # Pipeline progress tracker
│   ├── agent-votes-panel.tsx   # Agent voting display
│   ├── dashboard.tsx           # Main dashboard
│   └── ...
├── hooks/
│   └── use-live-data.ts        # Live data + analysis hook
├── lib/
│   ├── agents/
│   │   ├── types.ts            # Agent type definitions
│   │   ├── registry.ts         # Agent registration system
│   │   ├── builtin-agents.ts   # All built-in agents
│   │   ├── pipeline.ts         # Analysis pipeline
│   │   ├── self-evaluation.ts  # Learning system
│   │   └── index.ts
│   ├── dry-run.ts              # Paper trading engine
│   ├── engine.ts               # Go engine client
│   ├── signals.ts              # TA signal computation
│   └── types.ts                # Core types
└── README.md
```

## Adding New Agents

The architecture is designed for easy agent addition:

```typescript
// lib/agents/my-agent.ts
import { createAgent, agentRegistry } from "./registry"

const myAgent = createAgent({
  id: "my_custom_agent",
  name: "My Custom Agent",
  category: "trend",  // trend | mean_revert | sentiment | volume | risk | macro
  weight: 1.0,
  analyze: async (input) => {
    // Your analysis logic here
    return {
      agentId: "my_custom_agent",
      vote: "LONG",  // LONG | SHORT | WAIT | VETO
      confidence: 0.75,
      reasoning: "Explanation of the signal",
      metrics: { customMetric: 123 }
    }
  }
})

// Register in builtin-agents.ts or your own file
agentRegistry.register(myAgent)
```

## API Endpoints

### GET /api/agents/analyze?symbol=BTCUSDT

Run multi-agent analysis on a symbol.

**Response:**
```json
{
  "ok": true,
  "ts": 1234567890,
  "symbol": "BTCUSDT",
  "consensus": {
    "signal": "LONG",
    "confidence": 0.72,
    "reasoning": "...",
    "entry": 107500,
    "tp": 109200,
    "sl": 106300
  },
  "agentOutputs": [...],
  "progress": {
    "stage": "complete",
    "currentStep": 6,
    "totalSteps": 6
  },
  "evolution": {...}
}
```

### POST /api/agents/analyze

Submit trade result for self-evaluation.

**Request:**
```json
{
  "symbol": "BTCUSDT",
  "direction": "LONG",
  "pnlR": 1.5,
  "isWin": true,
  "agentVotes": [...]
}
```

### GET /api/market

Get real-time market data with computed signals.

## FAQ

**Q: Do I need to deploy to use this?**
No. Run `npm run dev` locally and everything works. Market data comes from public OKX API.

**Q: Is there demo/paper trading?**
Yes! Dry-run mode is enabled by default. No real trades execute unless you disable it AND connect a live trading engine.

**Q: Why does progress show 2/3 sometimes?**
This was a bug that's now fixed. The pipeline always completes all 6 stages with proper error handling. Each stage has timeout protection so one slow agent can't block the entire pipeline.

**Q: How does agent learning work?**
After each trade (paper or real), the system evaluates which agents voted correctly. Correct agents get weight boosts; wrong agents get penalties. After 3+ consecutive losses, a team-wide evaluation reduces weights on underperforming agents.

**Q: Can I add my own agents?**
Yes! See "Adding New Agents" section. The registry system allows hot-plugging without changing core architecture.

## Development

```bash
# Run development server
npm run dev

# Type checking
npm run lint

# Production build
npm run build

# Start production server
npm run start
```

## License

MIT
