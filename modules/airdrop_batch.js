const web3 = require('@solana/web3.js');
const splToken = require('@solana/spl-token');
const fs = require('fs');
const csv = require('csv-parse/sync');
const { stringify } = require('csv-stringify/sync');
const { ComputeBudgetProgram } = require('@solana/web3.js');

// Загрузка конфигурации
const config = JSON.parse(fs.readFileSync('config.json', 'utf-8'));

// Константы для управления скоростью запросов и лимитов
const MAX_RETRIES = 10;
const INITIAL_BACKOFF = 1000; // 1 секунда
const MAX_BACKOFF = 64000; // 64 секунды
const RPC_REQUESTS_PER_SECOND = 10;
const SEND_TRANSACTION_PER_SECOND = 1;

function readCSV(filePath) {
  const fileContent = fs.readFileSync(filePath, { encoding: 'utf-8' });
  return csv.parse(fileContent, { columns: true, skip_empty_lines: true });
}

function writeCSV(filePath, data) {
  const output = stringify(data, { header: true });
  fs.writeFileSync(filePath, output);
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function createTransferInstructions(connection, senderPublicKey, tokenPublicKey, recipient) {
  const instructions = [];
  const signers = [];

  const fromTokenAccount = await splToken.getAssociatedTokenAddress(
    tokenPublicKey,
    senderPublicKey
  );

  try {
    const toWallet = new web3.PublicKey(recipient.address);
    const amount = Math.floor(parseFloat(recipient.amount) * 10 ** config.tokenDecimals);

    const toTokenAccount = await splToken.getAssociatedTokenAddress(
      tokenPublicKey,
      toWallet
    );

    await sleep(1000 / RPC_REQUESTS_PER_SECOND); // Ожидание для соблюдения лимита RPC запросов
    const toAccountInfo = await connection.getAccountInfo(toTokenAccount);

    if (!toAccountInfo) {
      // Если токен-аккаунт не существует, добавляем инструкцию на его создание
      instructions.push(
        splToken.createAssociatedTokenAccountInstruction(
          senderPublicKey,
          toTokenAccount,
          toWallet,
          tokenPublicKey
        )
      );
    }

    // Добавляем инструкцию на перевод токенов
    instructions.push(
      splToken.createTransferInstruction(
        fromTokenAccount,
        toTokenAccount,
        senderPublicKey,
        amount
      )
    );
  } catch (error) {
    console.error(`Error processing recipient ${recipient.address}: ${error.message}`);
  }

  return { instructions, signers };
}

async function executeTransaction(connection, transaction, senderKeypair, batch, recipient) {
  let retries = 0;
  let delay = INITIAL_BACKOFF;

  while (retries < MAX_RETRIES) {
    try {
      await sleep(1000 / SEND_TRANSACTION_PER_SECOND); // Ожидание для соблюдения лимита отправки транзакций
      const signature = await web3.sendAndConfirmTransaction(connection, transaction, [senderKeypair]);
      console.log(`Batch ${batch} completed. Signature: ${signature}`);
      return { success: true, signature };
    } catch (error) {
      if (error.message.includes('429 Too Many Requests')) {
        console.log(`Rate limit exceeded. Retrying after ${delay}ms delay...`);
        await sleep(delay);
        delay = Math.min(delay * 2, MAX_BACKOFF);
        retries++;
      } else {
        return { success: false, error: error.message };
      }
    }
  }

  return { success: false, error: 'Max retries exceeded' };
}

async function performBatchAirdrop() {
  const connection = new web3.Connection(config.rpcUrl, 'confirmed');
  const senderKeypair = web3.Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(config.senderWalletPath, 'utf-8')))
  );
  const tokenPublicKey = new web3.PublicKey(config.tokenAddress);
  const airdropList = readCSV(config.inputCsvPath);
  const results = [];

  const MAX_TRANSACTION_SIZE = 1232;
  const ESTIMATED_INSTRUCTION_SIZE = 100;
  let transaction = new web3.Transaction();
  let transactionSize = 0;
  let currentBatch = 1;
  let currentBatchRecipients = []; // Временное хранение получателей в текущем batch

  for (let i = 0; i < airdropList.length; i++) {
    const recipient = airdropList[i];

    try {
      const { instructions } = await createTransferInstructions(connection, senderKeypair.publicKey, tokenPublicKey, recipient);
      
      const modifyComputeUnits = ComputeBudgetProgram.setComputeUnitLimit({
        units: 2000000
      });
      const addPriorityFee = ComputeBudgetProgram.setComputeUnitPrice({
        microLamports: 100_000
      });

      if (transactionSize === 0) {
        transaction.add(modifyComputeUnits).add(addPriorityFee);
        transactionSize += ESTIMATED_INSTRUCTION_SIZE * 2;
      }

      for (const instruction of instructions) {
        if (transactionSize + ESTIMATED_INSTRUCTION_SIZE > MAX_TRANSACTION_SIZE) {
          // Отправляем транзакцию
          const result = await sendTransaction(transaction, connection, senderKeypair, currentBatch, recipient);
          
          // Записываем результаты для каждого получателя в текущем batch
          for (const batchRecipient of currentBatchRecipients) {
            results.push({
              address: batchRecipient.address,
              amount: batchRecipient.amount,
              status: result.success ? 'success' : 'failed',
              signature: result.success ? result.signature : null,
              error: result.success ? null : result.error,
              batch: currentBatch
            });
          }

          // Обновляем CSV после каждой транзакции
          writeCSV(config.outputCsvPath, results);

          // Сбрасываем batch
          transaction = new web3.Transaction().add(modifyComputeUnits).add(addPriorityFee);
          transactionSize = ESTIMATED_INSTRUCTION_SIZE * 2;
          currentBatch++;
          currentBatchRecipients = [];
        }
        
        transaction.add(instruction);
        transactionSize += ESTIMATED_INSTRUCTION_SIZE;
      }
      
      currentBatchRecipients.push(recipient);

    } catch (error) {
      // Записываем ошибку для текущего получателя
      results.push({
        address: recipient.address,
        amount: recipient.amount,
        status: 'failed',
        signature: null,
        error: error.message,
        batch: currentBatch
      });

      writeCSV(config.outputCsvPath, results);
    }
  }

  // Отправляем последнюю транзакцию, если она не пустая
  if (transactionSize > 0 && currentBatchRecipients.length > 0) {
    const result = await sendTransaction(transaction, connection, senderKeypair, currentBatch, currentBatchRecipients[currentBatchRecipients.length - 1]);
    
    // Записываем результаты для всех получателей в последнем batch
    for (const batchRecipient of currentBatchRecipients) {
      results.push({
        address: batchRecipient.address,
        amount: batchRecipient.amount,
        status: result.success ? 'success' : 'failed',
        signature: result.success ? result.signature : null,
        error: result.success ? null : result.error,
        batch: currentBatch
      });
    }

    writeCSV(config.outputCsvPath, results);
  }

  console.log(`Airdrop completed! Results written to ${config.outputCsvPath}`);
}

async function sendTransaction(transaction, connection, senderKeypair, batch, recipient) {
  const result = await executeTransaction(connection, transaction, senderKeypair, batch, recipient);
  
  if (!result.success) {
    console.error(`Batch ${batch} failed: ${result.error}`);
  }
  
  // Задержка для ограничения скорости отправки транзакций
  await sleep(1000 / SEND_TRANSACTION_PER_SECOND);
  
  return result;
}

async function checkTokenBalance(connection, walletPublicKey, tokenPublicKey) {
  console.log(`Checking balance for wallet: ${walletPublicKey.toString()}`);
  console.log(`Token address: ${tokenPublicKey.toString()}`);

  try {
    await sleep(1000 / RPC_REQUESTS_PER_SECOND); // Ожидание для соблюдения лимита RPC запросов
    const tokenAccounts = await connection.getTokenAccountsByOwner(walletPublicKey, { mint: tokenPublicKey });

    if (tokenAccounts.value.length === 0) {
      console.log(`No token accounts found for this wallet and token.`);
      return;
    }

    for (let i = 0; i < tokenAccounts.value.length; i++) {
      const accountInfo = tokenAccounts.value[i];
      const accountAddress = accountInfo.pubkey.toString();
      const accountData = splToken.AccountLayout.decode(accountInfo.account.data);
      const balance = accountData.amount.toString();

      console.log(`Token account ${i + 1}:`);
      console.log(`  Address: ${accountAddress}`);
      console.log(`  Balance: ${balance / 10 ** config.tokenDecimals} tokens`);
    }
  } catch (error) {
    console.error(`Error checking token balance: ${error.message}`);
  }
}

async function main() {
  const connection = new web3.Connection(config.rpcUrl, 'confirmed');
  const senderKeypair = web3.Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(config.senderWalletPath, 'utf-8')))
  );
  const tokenPublicKey = new web3.PublicKey(config.tokenAddress);

  console.log(`Sender public key: ${senderKeypair.publicKey.toString()}`);
  console.log("Checking sender's token balance before airdrop:");
  await checkTokenBalance(connection, senderKeypair.publicKey, tokenPublicKey);

  console.log("Starting airdrop...");
  await performBatchAirdrop();

  console.log("Checking sender's token balance after airdrop:");
  await checkTokenBalance(connection, senderKeypair.publicKey, tokenPublicKey);

  // Проверка баланса нескольких случайных получателей
  const recipients = readCSV(config.inputCsvPath);
  for (let i = 0; i < 5; i++) {
    const randomRecipient = recipients[Math.floor(Math.random() * recipients.length)];
    console.log(`Checking token balance of random recipient ${i + 1}:`);
    await checkTokenBalance(connection, new web3.PublicKey(randomRecipient.address), tokenPublicKey);
  }
}

main().catch(console.error);