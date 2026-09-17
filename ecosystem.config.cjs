// pm2 ecosystem — TWO instances of the same code, one per network.
//   pm2 start ecosystem.config.cjs            # both
//   pm2 start ecosystem.config.cjs --only zunivo-mainnet
//   pm2 save
// Each instance loads its own env file via dotenv (DOTENV_CONFIG_PATH) and its own SQLite DB.
module.exports = {
  apps: [
    {
      name: "zunivo-mainnet",
      script: "npm",
      args: "start",
      env: { NODE_ENV: "production", DOTENV_CONFIG_PATH: ".env.mainnet" },
      max_restarts: 20,
      restart_delay: 3000,
      out_file: "logs/mainnet.out.log",
      error_file: "logs/mainnet.err.log",
      time: true,
    },
    {
      name: "zunivo-testnet",
      script: "npm",
      args: "start",
      env: { NODE_ENV: "production", DOTENV_CONFIG_PATH: ".env.testnet" },
      max_restarts: 20,
      restart_delay: 3000,
      out_file: "logs/testnet.out.log",
      error_file: "logs/testnet.err.log",
      time: true,
    },
  ],
};
