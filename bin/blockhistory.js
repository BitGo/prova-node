const ProvaNode = require('..').ProvaNode;
const Promise = require('bluebird');
const co = Promise.coroutine;

const main = co(function *() {
  const node = new ProvaNode({ rpcport: 18334, username: 'user', password: 'pass', host: 'localhost' });

  const height = (yield node.getinfo()).blocks;

  lastTime = 0;
  for (let i=0; i <= height; i++) {
    const hash = yield node.getblockhash(i);
    const info = yield node.getblock(hash, true);
    console.log(`${i},${info.difficulty},${info.time - lastTime}`);
    lastTime = info.time;
  }
});

main();
