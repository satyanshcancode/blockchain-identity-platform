#!/bin/sh
set -e

npx hardhat node --hostname 0.0.0.0 &
NODE_PID=$!

echo "Waiting for Hardhat node to boot..."
sleep 6

echo "Deploying contracts..."
npx hardhat run scripts/deploy.js --network localhost

echo ""
echo "Contracts deployed. Hardhat RPC is live on port 8545."
echo "If addresses above differ from backend/.env, update them and restart the backend service."

wait $NODE_PID
