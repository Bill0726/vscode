"use strict";
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
Object.defineProperty(exports, "__esModule", { value: true });
exports.spawnCommand = exports.createConnection = exports.createServer = void 0;
const path = require("path");
const net = require("net");
const os = require("os");
const fs = require("fs");
const cp = require("child_process");
const readline = require("readline");
const crypto = require("crypto");
const treekill = require("tree-kill");
function getIPCHandle(command) {
    const scope = crypto.createHash('md5')
        .update(command.path)
        .update(command.args.toString())
        .update(command.cwd)
        .digest('hex');
    if (process.platform === 'win32') {
        return `\\\\.\\pipe\\daemon-${scope}`;
    }
    else {
        return path.join(process.env['XDG_RUNTIME_DIR'] || os.tmpdir(), `daemon-${scope}.sock`);
    }
}
async function createServer(handle) {
    return new Promise((c, e) => {
        const server = net.createServer();
        server.on('error', e);
        server.listen(handle, () => {
            server.removeListener('error', e);
            c(server);
        });
    });
}
exports.createServer = createServer;
function createConnection(handle) {
    return new Promise((c, e) => {
        const socket = net.createConnection(handle, () => {
            socket.removeListener('error', e);
            c(socket);
        });
        socket.once('error', e);
    });
}
exports.createConnection = createConnection;
function spawnCommand(server, command) {
    const clients = new Set();
    const buffer = [];
    const child = cp.spawn(command.path, command.args);
    child.stdout.on('data', data => buffer.push(data));
    server.on('connection', socket => {
        for (const data of buffer) {
            socket.write(data);
        }
        child.stdout.pipe(socket);
        clients.add(socket);
        socket.on('data', () => {
            treekill(child.pid);
        });
        socket.on('close', () => {
            child.stdout.unpipe(socket);
            clients.delete(socket);
        });
    });
    child.on('exit', () => {
        for (const client of clients) {
            client.destroy();
        }
        server.close();
        process.exit(0);
    });
}
exports.spawnCommand = spawnCommand;
async function connect(command, handle) {
    try {
        return await createConnection(handle);
    }
    catch (err) {
        if (err.code === 'ECONNREFUSED') {
            await fs.promises.unlink(handle);
        }
        else if (err.code !== 'ENOENT') {
            throw err;
        }
        cp.spawn(process.execPath, [process.argv[1], '--daemon', command.path, ...command.args], {
            detached: true,
            stdio: 'inherit'
        });
        await new Promise(c => setTimeout(c, 200));
        return await createConnection(handle);
    }
}
async function main(command, options) {
    const handle = getIPCHandle(command);
    if (options.daemon) {
        const server = await createServer(handle);
        return spawnCommand(server, command);
    }
    let socket = await connect(command, handle);
    if (options.kill) {
        socket.write('kill');
        return;
    }
    if (options.restart) {
        socket.write('kill');
        await new Promise(c => setTimeout(c, 500));
        socket = await connect(command, handle);
    }
    readline.emitKeypressEvents(process.stdin);
    if (process.stdin.isTTY && process.stdin.setRawMode) {
        process.stdin.setRawMode(true);
    }
    process.stdin.on('keypress', code => {
        if (code === '\u0003') { // ctrl c
            console.log('Disconnected from build daemon, it will stay running in the background.');
            process.exit(0);
        }
        else if (code === '\u0004') { // ctrl d
            console.log('Killed build daemon.');
            socket.write('kill');
            process.exit(0);
        }
    });
    socket.pipe(process.stdout);
    socket.on('close', () => {
        console.log('Build daemon exited.');
        process.exit(0);
    });
}
if (process.argv.length < 3) {
    console.error('Usage: node daemon.js [OPTS] COMMAND [...ARGS]');
    process.exit(1);
}
const commandPathIndex = process.argv.findIndex((arg, index) => !/^--/.test(arg) && index >= 2);
const [commandPath, ...commandArgs] = process.argv.slice(commandPathIndex);
const command = {
    path: commandPath,
    args: commandArgs,
    cwd: process.cwd()
};
const optionsArgv = process.argv.slice(2, commandPathIndex);
const options = {
    daemon: optionsArgv.some(arg => /^--daemon$/.test(arg)),
    kill: optionsArgv.some(arg => /^--kill$/.test(arg)),
    restart: optionsArgv.some(arg => /^--restart$/.test(arg))
};
main(command, options).catch(err => {
    console.error(err);
    process.exit(1);
});
