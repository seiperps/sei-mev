const { Wallet } = require('ethers');

// Generate a random wallet
const wallet = Wallet.createRandom();

// Print out the private key and the associated address
console.log('Private Key:', wallet.privateKey);
console.log('Address:', wallet.address);
