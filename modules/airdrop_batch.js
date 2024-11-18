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

function appendToCSV(filePath, data) {
  // Проверяем существует ли файл
  let existingData = [];
  if (fs.existsSync(filePath)) {
    existingData = readCSV(filePath);
  }
  
  // Добавляем новые данные
  existingData.push(data);
  
  // Записываем обновленный файл
  writeCSV(filePath, existingData);
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

    await sleep(1000 / RPC_REQUESTS_PER_SECOND);
    const toAccountInfo = await connection.getAccountInfo(toTokenAccount);

    if (!toAccountInfo) {
      instructions.push(
        splToken.createAssociatedTokenAccountInstruction(
          senderPublicKey,
          toTokenAccount,
          toWallet,
          tokenPublicKey
        )
      );
    }

    instructions.push(
      splToken.createTransferInstruction(
        fromTokenAccount,
        toTokenAccount,
        senderPublicKey,
        amount
      )
    );

    return { instructions, signers, success: true };
  } catch (error) {
    console.error(`Error creating instructions for recipient ${recipient.address}: ${error.message}`);
    return { instructions: [], signers: [], success: false, error: error.message };
  }
}

async function executeTransaction(connection, transaction, senderKeypair, recipient) {
  let retries = 0;
  let delay = INITIAL_BACKOFF;

  while (retries < MAX_RETRIES) {
    try {
      await sleep(1000 / SEND_TRANSACTION_PER_SECOND);
      const signature = await web3.sendAndConfirmTransaction(connection, transaction, [senderKeypair]);
      
      // Записываем успешный результат
      const result = {
        timestamp: new Date().toISOString(),
        address: recipient.address,
        amount: recipient.amount,
        status: 'success',
        signature: signature,
        error: null
      };
      appendToCSV(config.outputCsvPath, result);
      
      console.log(`Transfer completed. Recipient: ${recipient.address}, Amount: ${recipient.amount}, Signature: ${signature}`);
      return { success: true, signature };
    } catch (error) {
      if (error.message.includes('429 Too Many Requests')) {
        console.log(`Rate limit exceeded. Retrying after ${delay}ms delay...`);
        await sleep(delay);
        delay = Math.min(delay * 2, MAX_BACKOFF);
        retries++;
      } else {
        // Записываем неудачный результат
        const result = {
          timestamp: new Date().toISOString(),
          address: recipient.address,
          amount: recipient.amount,
          status: 'failed',
          signature: null,
          error: error.message
        };
        appendToCSV(config.outputCsvPath, result);
        
        return { success: false, error: error.message };
      }
    }
  }

  // Записываем результат после превышения лимита попыток
  const result = {
    timestamp: new Date().toISOString(),
    address: recipient.address,
    amount: recipient.amount,
    status: 'failed',
    signature: null,
    error: 'Max retries exceeded'
  };
  appendToCSV(config.outputCsvPath, result);

  return { success: false, error: 'Max retries exceeded' };
}

async function performBatchAirdrop() {
  const connection = new web3.Connection(config.rpcUrl, 'confirmed');
  const senderKeypair = web3.Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(config.senderWalletPath, 'utf-8')))
  );
  const tokenPublicKey = new web3.PublicKey(config.tokenAddress);
  const airdropList = readCSV(config.inputCsvPath);

  // Создаем файл результатов, если он не существует
  if (!fs.existsSync(config.outputCsvPath)) {
    writeCSV(config.outputCsvPath, []);
  }

  const MAX_TRANSACTION_SIZE = 1232;
  const ESTIMATED_INSTRUCTION_SIZE = 100;
  let transaction = new web3.Transaction();
  let transactionSize = 0;
  let currentRecipients = [];

  for (let i = 0; i < airdropList.length; i++) {
    const recipient = airdropList[i];
    console.log(`Processing recipient ${i + 1}/${airdropList.length}: ${recipient.address}`);

    try {
      const { instructions, signers, success, error } = await createTransferInstructions(
        connection, 
        senderKeypair.publicKey, 
        tokenPublicKey, 
        recipient
      );

      if (!success) {
        console.error(`Failed to create instructions for ${recipient.address}: ${error}`);
        continue;
      }

      // Увеличение вычислительного лимита и приоритета транзакции
      if (transactionSize === 0) {
        const modifyComputeUnits = ComputeBudgetProgram.setComputeUnitLimit({
          units: 2000000
        });
        const addPriorityFee = ComputeBudgetProgram.setComputeUnitPrice({
          microLamports: 100_000
        });
        transaction.add(modifyComputeUnits).add(addPriorityFee);
        transactionSize += ESTIMATED_INSTRUCTION_SIZE * 2;
      }

      // Проверяем, не превысит ли добавление новых инструкций максимальный размер транзакции
      const newInstructionsSize = instructions.length * ESTIMATED_INSTRUCTION_SIZE;
      if (transactionSize + newInstructionsSize > MAX_TRANSACTION_SIZE) {
        // Отправляем текущую транзакцию
        await executeTransaction(connection, transaction, senderKeypair, recipient);

        // Начинаем новую транзакцию
        transaction = new web3.Transaction();
        const modifyComputeUnits = ComputeBudgetProgram.setComputeUnitLimit({
          units: 2000000
        });
        const addPriorityFee = ComputeBudgetProgram.setComputeUnitPrice({
          microLamports: 100_000
        });
        transaction.add(modifyComputeUnits).add(addPriorityFee);
        transactionSize = ESTIMATED_INSTRUCTION_SIZE * 2;
        currentRecipients = [];
      }

      // Добавляем инструкции в транзакцию
      for (const instruction of instructions) {
        transaction.add(instruction);
      }
      transactionSize += newInstructionsSize;
      currentRecipients.push(recipient);

    } catch (error) {
      console.error(`Error processing recipient ${recipient.address}: ${error.message}`);
      // Записываем ошибку в CSV
      const result = {
        timestamp: new Date().toISOString(),
        address: recipient.address,
        amount: recipient.amount,
        status: 'failed',
        signature: null,
        error: error.message
      };
      appendToCSV(config.outputCsvPath, result);
    }
  }

  // Отправляем последнюю транзакцию, если она не пустая
  if (transactionSize > ESTIMATED_INSTRUCTION_SIZE * 2) {
    await executeTransaction(connection, transaction, senderKeypair, currentRecipients[currentRecipients.length - 1]);
  }

  console.log(`Airdrop completed! Results written to ${config.outputCsvPath}`);
}

async function checkTokenBalance(connection, walletPublicKey, tokenPublicKey) {
  console.log(`Checking balance for wallet: ${walletPublicKey.toString()}`);
  console.log(`Token address: ${tokenPublicKey.toString()}`);

  try {
    await sleep(1000 / RPC_REQUESTS_PER_SECOND);
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
}

main().catch(console.error);