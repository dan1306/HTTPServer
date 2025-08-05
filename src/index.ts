import { rejects } from 'assert';
import { Buffer } from 'buffer';
import { Socket } from 'dgram';
import { CONNREFUSED } from 'dns';
import { connect } from 'http2';
import { builtinModules } from 'module';
import * as net from 'net';
import { resolve } from 'path';
import { exitCode } from 'process';

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


//a parsed HTTP request header
type HTTPReq = {
    method: string,
    uri: Buffer,
    version: string,
    headers: Buffer[]
} 

//  an HTTP response
type HTTPRes = {
    code: number, 
    headers: Buffer[],
    body: BodyReader,
}

// an interfae for reading/writing data from/to the HTTP body.
type BodyReader = {
    // the "content-length", -1 if unknown
    length: number,
    // read data. returns an empty buffer after EOF.
    read: ()=> Promise<Buffer>
}

// the max length of an HTTP header
const kMaxHeaderLen = 1024 * 8;

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

// parse & remove a header from the beggining of the Buffer if possible
function cutMessage( buf: DynBuf ): null | HTTPReq {
    // the end of the header is marked by '\r\n\r\n'
    const idx = buf.data.subarray(0, buf.length).indexOf('\r\n\r\n');
    if(idx < 0) {
        if( buf.length >= kMaxHeaderLen) {
            throw new HTTPError(413, 'header is too large');
        }
        return null; // need more data
    }

    // parse & remove the header
    const msg = parseHTTPReq(buf.data.subarray(0, idx + 4));
    buffPop(buf, idx + 4);
    return msg; 
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

// parse an HTTP Req header
function parseHTTPReq(data: Buffer): HTTPReq {
    // split the data into lines
    const lines: Buffer[] = splitLines(data);
    // the first line is 'METHOD URI VERSION'
    const [method, uri, version] = parseHTTPRequestLine(lines[0]);
    // followed by header fields in the format of 'Name: value'
    const headers: Buffer[] = [];
    for(let i = 1; i < lines.length - 1; i++) {
        const h = Buffer.from(lines[i]) //copy
        if(!validateHeader(h)) {
            throw new HTTPError(400, 'bad field');
        }
        headers.push(h);
    }
    // the header ends by an empty line
    console.assert(lines[lines.length - 1].length === 0)
    return {
        method: method, uri: uri, version: version, headers: headers
    }
}

// BodtReader from an HTTP request
function readerFromReq(conn: TCPConn, BUF: DynBuf, req: HTTPReq): BodyReader {
    let bodyLen = - 1;
    const contentLen = fieldGet(req.headers, 'Content-Lengtg');
    if(contentLen) {
        bodyLen = parseDec(contentLen.toString('latin1'));
        if(isNaN(bodyLen)) {
            throw new HTTPError(400, 'bad Content-Length');
        }
    }
    const bodyAllowed = !(req.method === 'GET' || req.method == 'Head');

    const chunked = filedGet(req.headers, 'Transfer-Encoding')?.equals(Buffer.from('chuncked')) ||false;
    if(!bodyAllowed && (bodyLen > 0)) {
        throw new HTTPError(400, 'HTTP body not allowed.');
    }

    if(!bodyAllowed) {
        bodyLen = 0;
    }

    if(bodyLen >= 0) {
        //'Content-length' is present
        return readerFromConnLength(conn, buf, bodyLen);
    } else if (chunked) {
        // chuncked encoding
        throw new HTTPError(501, 'TODO');
    } else {
        // read the rest of the connection
        throw new HTTPError(501, 'TODO');
    }
} 

// BodyReader from a socket with a known length
function readerFromConnLength(conn: TCPConn, buf: DynBuf, remain: number) : BodyReader {
    return {
        length: remain,
        read: async (): Promise<Buffer> => {
            if (remain == 0) {
                return Buffer.from("");// done

            }
            if (buf.length == 0) {
                // try to get some data if there is none
                const data = await soRead(conn);
                bufPush(buf, data);
                if(data.length === 0) {
                    // expect mroe data
                    throw new Error('Unexpected EOF from HTTP body');

                }
            }

            // consume data from the buffer
            const consume = Math.min(buf.length, remain);
            remain -= consume;
            const data = Buffer.from(buf.data.subarray(0, consume));
            bufPop(buf, consume);
            return data;
        }
    }
}

// BodyReader from in-memory data
function readerFromMemory(data: Buffer): BodyReader {
    let done = false;
    return {
        length: data.length,
        read: async (): Promise<Buffer> => {
            if (done) {
                return Buffer.from(''); // no more data
            } else {
                done = true;
                return data;
            }
        }
    }
}

// send an HTTP response through the socket
async function writeHTTPResp(conn: TCPConn, resp: HTTPRes): Promise<void> {
    if (resp.body.length < 0) {
        throw new Error('TODO: chunked encoding');
    }

    // set the 'Content-Length' field
    console.assert(!fieldGet(resp.headers, 'Content-Length'));
    resp.headers.push(Buffer.from(`Content-Length: ${resp.body.length}`));
    // write the header
    await soWrite(conn, encodeHTTPResp(resp));
    // write the body
    while(true) {
        const data = await resp.body.read();
        if (data.length == 0) {
            break;
        }
        await soWrite(conn, data);
    }
}
async function newConn(socket: net.Socket): Promise<void> {
    // console.log('new connection', socket.remoteAddress, socket.remotePort);
    const conn: TCPConn = soInit(socket);
    try {
        await serveClient(socket);
    } catch( exec ) {
        console.error( "exception:", exec);
        if (exec instanceof HTTPError) {
            // intended to send an error response
            const resp: HTTPRes = {
                code: exc.code,
                headers: [],
                body: readerFromMemory(Buffer.from(exc.message + '\n')),
            };
        }

        try {
            await writeHTTPResp(conn, resp);
        } catch (exc) {
            // ignore
        }
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
        // try to get 1 request header from the buffer
        const msg: null|HTTPReq = cutMessage(buf);
        if (!msg){
            // need more data 
            const data: Buffer = await soRead(conn);
            bufPush(buf, data);
            // EOF
            if(data.length == 0 && buf.length == 0){
                console.log('end communication');
                return;
            }

            if(data.length == 0 ){
                throw new HTTPError(400, "Unexpected EOF.");
            }
            // got some data, try it again
            continue;
        }

        // process the message and send the response

        const reqBody: BodyReader = readFromReq(conn, buff, msg);
        const res: HTTPRes = await handleReq(msg, reqBody);
        await writeHTTPResp(conn, res);
        // close the connection for HTTP/1.0
        if(msg.version == '1.0'){
            return;
        }
        // make sure that the request body is consumed completely
        while((await reqBody.read()).length > 0 ) {
            // empty
        } // loop for 10



        
        // if(msg!.equals(Buffer.from('quit\n'))){
        //     await soWrite(conn, Buffer.from('Bye.\n'));
        //     socket.destroy();
        //     return;
        // } else {
        //     const reply = Buffer.concat([Buffer.from('Echo: '), msg]);
        //     await soWrite(conn, reply);
        // }
        // // const data = await soRead(conn);
        // if (data.length === 0) {
        //     console.log('end communication');
        //     break;
        // }; 
        // console.log();
        // console.log('data: ', data);
        // await soWrite(conn, data);
    };
};


// a sample req handler

async function handleReq(req: HTTPReq, body: BodyReader): Promise<HTTPRes> {
    // act on the req URI
    let resp: BodyReader;
    switch(req.uri.toString('latin1')) {
        case '/echo':
            // http echo server
            resp = body;
            break
        default:
            resp = readerFromMemory(Buffer.from('hello world.\n'));
            break;
    }

    return {
        code: 200,
        headers: [Buffer.from('Server: my_first_http_server')],
        body resp,
    }
}