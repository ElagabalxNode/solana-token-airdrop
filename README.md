# Solana Token Airdrop Script

This repository contains a Node.js script for performing token airdrops on the Solana blockchain. The script supports batch processing, error handling, and CSV input/output.

## Prerequisites

- Node.js (v16 or higher)
- npm (Node Package Manager)
- Git

## Installation

1. Clone the repository:
```bash
git clone https://github.com/YOUR_USERNAME/solana-token-airdrop.git
cd solana-token-airdrop
```

2. Install dependencies:
```bash
npm install
```

## Configuration

1. Create a `config.json` file with your settings:
```json
{
  "rpcUrl": "YOUR_RPC_URL",
  "tokenAddress": "YOUR_TOKEN_ADDRESS",
  "tokenDecimals": 8,
  "senderWalletPath": "sender_wallet.json",
  "inputCsvPath": "airdrop_list.csv",
  "outputCsvPath": "airdrop_results.csv"
}
```

2. Create a `sender_wallet.json` file with your wallet private key.

3. Prepare an `airdrop_list.csv` file with recipient addresses and amounts:
```csv
address,amount
WALLET_ADDRESS_1,100
WALLET_ADDRESS_2,200
```

## Usage

Run the script:
```bash
node airdrop_batch.js
```

The script will:
- Process transactions in batches
- Handle rate limiting and retries
- Save results to `airdrop_results.csv`
- Display progress and balances

## Important Notes

- Keep your `sender_wallet.json` private and never commit it to the repository
- Always test with small amounts first
- Monitor the transaction output for any errors