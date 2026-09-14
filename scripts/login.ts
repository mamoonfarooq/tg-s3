import { TelegramClient, MemoryStorage } from '@mtcute/node';
// @ts-ignore
import input from 'input';
import qrcode from 'qrcode-terminal';
import dotenv from 'dotenv';

dotenv.config();

async function login() {
  const appId = parseInt(process.env.TG_APP_ID || process.env.TG_API_ID || '', 10);
  const appHash = process.env.TG_APP_HASH || process.env.TG_API_HASH || '';

  if (!appId || !appHash) {
    console.error('Error: TG_APP_ID / TG_API_ID and TG_APP_HASH / TG_API_HASH must be set in your .env file before logging in.');
    process.exit(1);
  }

  console.log('=== TG-S3 Telegram Account Login via QR Code (mtcute) ===');
  console.log(`Using App ID: ${appId}`);
  console.log(`Using App Hash: ${appHash.substring(0, 4)}...${appHash.slice(-4)}`);

  const client = new TelegramClient({
    apiId: appId,
    apiHash: appHash,
    storage: new MemoryStorage(),
    logLevel: 3,
  });

  console.log('\nConnecting to Telegram MTProto data centers...');

  const user = await client.start({
    qrCodeHandler: (url, expires) => {
      console.log('\n===================================================');
      console.log(' SCAN THIS QR CODE IN YOUR TELEGRAM APP');
      console.log(' 1. Open Telegram on your phone');
      console.log(' 2. Go to Settings -> Devices -> Link Desktop Device');
      console.log(' 3. Scan the QR code below');
      console.log(` Code expires at: ${expires.toLocaleTimeString()}`);
      console.log('===================================================\n');
      qrcode.generate(url, { small: true });
    },
    password: async () => {
      return await input.text('Please enter your 2FA password: ');
    },
  });

  console.log(`\nUser authentication successful for ${user.displayName}!`);
  const sessionString = await client.exportSession();

  console.log('\nCopy the following TG_SESSION string into your .env file:\n');
  console.log('--------------------------------------------------');
  console.log(`TG_SESSION=${sessionString}`);
  console.log('--------------------------------------------------\n');

  await client.destroy();
}

login().catch((err) => {
  console.error('\nLogin failed with error:');
  console.error(err);
  process.exit(1);
});