# Stocks

Part of the [owner guide](../owner-guide.md) (one file per page). Hindi: [stock.hi.md](stock.hi.md). The codes in brackets are spec IDs in [calculations.md](../calculations.md).

| On screen | How it is worked out |
|---|---|
| Quantity (S1) | All purchases added, sales taken out, corrections applied, in time order. Opening stock is a correction with its cost per kg. |
| Average rate (S2) | The average cost after all of that. |
| Value per item, total value (S3, S4) | Quantity × average rate; the total is their sum. |
| Adjustment value (S5) | Quantity of a correction × its rate (or today's average rate). |
| Dead stock value (S6) | Value of items with stock and no sale in the chosen days. |
