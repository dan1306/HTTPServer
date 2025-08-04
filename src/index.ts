import { rejects } from 'assert';
import { Buffer } from 'buffer';
import { Socket } from 'dgram';
import { connect } from 'http2';
import { builtinModules } from 'module';
import * as net from 'net';
import { resolve } from 'path';

let server = net.createServer({
    pauseOnConnect: true, // required by 'TCPConn'
});

server.on('error', (err: Error) => {throw err;} );

server.on('connection', newConn);

server.listen({host: '127.0.0.1', port: 1234});

type TCPConn = {
    // THE JS socket object
    socket: net.Socket;
    // the callbacks of the promise of the current read
    reader: null | {
        resolve: (value: Buffer) => void,
        reject: (reason: Error) => void,
    };

    // from the 'error' event
    err: null | Error;
    // EOF, deom the 'end' event
    ended: boolean
}

// A dynamic-sized buffer

type DynBuf = {
    data: Buffer, // data.length actual siz of the buffer
    length: number, // how much of the buffer is occupied
}

// append data to Dynbuf

function bufPush(buf: DynBuf, data:Buffer): void {
    const newLen = buf.length + data.length;
    if(buf.data.length < newLen) {
        let cap = Math.max(buf.data.length, 32);
        while(cap < newLen) {
            cap *= 2;
        }
        const grown = Buffer.alloc(cap);
        buf.data.copy(grown, 0, 0);
        buf.data = grown;
    }

    data.copy(buf.data, buf.length, 0); // data.copy src buffer, copy into buf.data, start writing from buf.length, start reading from the 0th index in old buffer
    buf.length = newLen;
}

function cutMessage( buf: DynBuf ): null | Buffer {

    // message are seperated by '\n'
    const idx = buf.data.subarray(0, buf.length).indexOf('\n');
    if(idx < 0) {
        return null; // not complete
    }

    // make a copy of the message and move the remaning data to the front
    const msg = Buffer.from(buf.data.subarray(0, idx + 1));
    bufPop(buf, idx + 1);
    return msg

}

function bufPop(buf: DynBuf, len: number): void {
    buf.data.copyWithin(0, len, buf.length); // buf.copyWithin(dst, src_start, src_end)
    buf.length -= len;
}

function soInit(socket: net.Socket): TCPConn {
    const conn: TCPConn = {
        socket: socket,
        reader: null,
        ended: false,
        err: null
    };

    socket.on('data', (data:Buffer) => {
        console.assert(conn.reader);
        // pause the 'data' event until the next read
        conn.socket.pause();
        // fullfill the promise of the current read
        conn.reader!.resolve(data);
        conn.reader = null;
    });

    socket.on('end', ()=>{
        // this also fulfills the current read.
        conn.ended = true;
        if(conn.reader){
            conn.reader.resolve(Buffer.from("")); //EOF
            conn.reader = null;
        };

    });

    socket.on('error', (err: Error) => {
        // errors are also delivered to the current read
        conn.err = err;
        if(conn.reader) {
            conn.reader.reject(err);
            conn.reader = null;
        }
    })
    return conn;
}

function soWrite(conn: TCPConn, data: Buffer ): Promise<void> {
    console.assert(data.length > 0);
    return new Promise((resolve, reject) => {
        if(conn.err) {
            reject(conn.err);
            return;
        }

        conn.socket.write(data, (err: Error | null | undefined) => {
            if(err) {
                reject(err);
            } else {
                resolve();
            }
        });

    });
};

function soRead(conn:TCPConn): Promise<Buffer> {
    console.assert(!conn.reader); // no concurrent calls
    return new Promise((resolve, reject) => {
        // if the connection is not readable, complete the promise now

        if(conn.err) {
            reject(conn.err);
            return;
        }

        if(conn.ended) {
            resolve(Buffer.from(""));
            return;
        }

        // save the promise callbacks
        conn.reader = {resolve: resolve, reject: reject};
        // and resume the 'data' event to fullfill the promise later.
        conn.socket.resume();
    })
}

async function newConn(socket: net.Socket): Promise<void> {
    console.log('new connection', socket.remoteAddress, socket.remotePort);
    try {
        await serveClient(socket);
    } catch( exec ) {
        console.error( "exception:", exec);
    } finally {
        socket.destroy(); 
    }
    // socket.on('end', ()=>{
    //     // FIN received. The connection will be closed automatically

    //     console.log('FIN');
    // })

    // socket.on('data', (data: Buffer) => {
    //     console.log('data:', data);
    //     socket.write(data);

    //     //actively closed the connection if the data contains a "q"

    //     if(data.includes('q')){
    //         console.log('closing');
    //         socket.end(); //sends FIN and close the connection
    //     };
    // });
    
    // socket.on('end', ()=>{
    //     // this also fullfilss the current read.
    //     conn.ended = true;

    // })
}

// echo server

async function serveClient(socket:net.Socket): Promise<void> {
    const conn: TCPConn = soInit(socket);
    const buf: DynBuf = {data: Buffer.alloc(0), length: 0};
    while(true) {
        const data = await soRead(conn);
        if (data.length === 0) {
            console.log('end communication');
            break;
        }; 
        console.log();
        console.log('data: ', data);
        await soWrite(conn, data);
    };
};