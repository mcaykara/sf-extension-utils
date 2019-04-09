/**
 * Smartface Service-Call-Offline module.
 * This module provides classes to be instead of ServiceCall class for some offline capability.
 * 
 * Requiring this module creates a database file under DataDirectory named as service-call.sqlite
 * @module service-call-offline
 * @type {object}
 * @author Alper Ozisik <alper.ozisik@smartface.io>
 * @author Ozcan Ovunc <ozcan.ovunc@smartface.io>
 * @copyright Smartface 2019
 */
const System = require("sf-core/device/system");
const SQLite_HARD_LIMIT = 1000000; // https://www.sqlite.org/limits.html
const SQL_STATEMENT_SIZE_BUFFER = 2000;
const MAX_STRING_SIZE = SQLite_HARD_LIMIT - SQL_STATEMENT_SIZE_BUFFER;
const reSplitter = new RegExp(`.{1,${MAX_STRING_SIZE}}`, "g");
const Database = require('sf-core/data').Database;
const Path = require('sf-core/io/path');
const File = require('sf-core/io/file');
const dbFilePath = `${Path.DataDirectory}/service-call.sqlite`;
const ServiceCall = require("./service-call");
const Network = require("sf-core/device/network");
const { createAsyncTask } = require("./async");
const dbFile = new File({ path: dbFilePath });
if (!dbFile.exists)
    dbFile.createFile();
const reDataCoumnName = /^data\d+$/;
const squel = require("squel");
const AsyncLock = require('async-lock');
const guid = require("./guid");
const copy = require("./copy");
const TABLE_NAMES = Object.freeze({
    REQUESTS: "requests",
    RESPONSES: "responses",
    PENDING_REQUESTS: "pending"
});
var sameReturner = e => e;
var encryptFunction;
var decryptFunction;
var isConfigured;

const database = new Database({
    file: dbFile
});

const execute = (() => {
    let lock = new AsyncLock();
    return f => {
        return lock.acquire("database", () => {
            f.call(null);
            return Promise.resolve();
        });
    };
})();

const splitString = (text = "") => {
    reSplitter.lastIndex = 0;
    return text.match(reSplitter) || [];
};

const getRowsArray = queryResult => {
    let arr = [];
    let count = queryResult.count();
    for (let i = 0; i < count; i++) {
        if (System.OS === "Android") { //SUPDEV-1882
            arr.push({
                getString: function(rowIndex, columnName) {
                    return queryResult.get(rowIndex).getString(columnName);
                }.bind(null, i)
            });
        }
        else
            arr.push(queryResult.get(i));
    }
    return arr;
};

const getCoumnNamesOfATable = tableName => {
    let query = `PRAGMA table_info(${tableName})`;
    let queryResult = database.query(query);
    let result = getRowsArray(queryResult).map(row => row.getString("name"));
    queryResult.android.close();
    return result;
};

const getDataColumnNames = tableNameOrColumnList => {
    let columnNames;
    if (tableNameOrColumnList instanceof Array)
        columnNames = tableNameOrColumnList;
    else if (typeof tableNameOrColumnList === "string")
        columnNames = getCoumnNamesOfATable(tableNameOrColumnList);
    else
        throw Error("Not expected type for tableNameOrColumnList");
    return columnNames.filter(cn => {
        reDataCoumnName.lastIndex = 0;
        return reDataCoumnName.test(cn);
    });
};

const expandTable = (tableName, from, to) => {
    for (let i = from; i < to; i++) {
        let query = `ALTER TABLE ${tableName} ADD COLUMN data${i} TEXT;`;
        execute(() => database.execute(query));
    }
};

const insertIntoTable = (tableName, data, /*type,*/ id = guid()) => {
    data = encryptFunction(JSON.stringify(data));

    let chunks = splitString(data);
    let dataColumns = getDataColumnNames(tableName);
    if (chunks.length > dataColumns.length) {
        expandTable(tableName, dataColumns.length, chunks.length);
    }

    let deleteRowQuery = squel.delete()
        .from(tableName)
        .where("id = ?", id)
        .toString();

    let createRowQuery = squel.insert()
        .into(tableName)
        .set("id", id)
        .set("timestamp", timestamp())
        .toString();

    let queries = chunks.map((chunk, index) => {
        let q = squel.update({ replaceSingleQuotes: true })
            .table(tableName)
            .set(`data${index}`, chunk)
            .where(`${tableName}.id = ?`, id)
            .toString();
        return q;
    });

    execute(() => {
        database.execute("BEGIN TRANSACTION");
        database.execute(deleteRowQuery);
        database.execute(createRowQuery);
        queries.forEach(query => database.execute(query));
        database.execute("COMMIT");
    });

    return id;
};

const createTable = (tableName, extended) => {
    let extendedPart = "";
    if (extended)
        extendedPart = "'jobid' TEXT, ";
    let createTableQuery = `CREATE TABLE IF NOT EXISTS '${tableName}' ('id'	TEXT NOT NULL,'timestamp' TEXT NOT NULL, ${extendedPart}'data0' TEXT, PRIMARY KEY('id'))`;
    execute(() => database.execute(createTableQuery));
};

Object.keys(TABLE_NAMES).forEach(tableName => createTable(TABLE_NAMES[tableName], tableName === "PENDING_REQUESTS"));

const getRecord = (tableName, requestObjectOrId) => {
    let requestObject, id;
    if (typeof requestObjectOrId !== "string")
        requestObject = encryptFunction(JSON.stringify(requestObjectOrId));
    else {
        id = requestObjectOrId;
    }

    if (!id) {
        let keys = splitString(requestObject);
        let possibleIds = null;
        for (let i = 0; i < keys.length; i++) {
            let k = keys[i];
            let queryObject = squel.select()
                .field("id")
                .from(tableName)
                .where(`data${i} = ?`, k);

            if (possibleIds)
                queryObject = queryObject
                .where("id in ?", possibleIds);

            let query = queryObject.toString();
            let queryResult = database.query(query);
            possibleIds = getRowsArray(queryResult).map(row => row.getString("id"));
            queryResult.android.close();
            if (possibleIds.length === 0)
                break;
        }
        if (possibleIds.length === 0) {
            return null;
        }
        else if (possibleIds.length === 1) {
            id = possibleIds[0];
        }
        else {
            throw Error(`possibleIds.length should be 0 or 1, encountered ${possibleIds.length}`);
        }
    }

    let dataColumns = getDataColumnNames(tableName);
    let dataParts = dataColumns.map(column => {
        let query = squel.select()
            .field(column)
            .from(tableName)
            .where("id = ?", id)
            .toString();

        let queryResult = database.query(query);
        let result = queryResult.get(0).getString(column);
        queryResult.android.close();
        return result;
    });
    let dataString = dataParts.join("");
    let data = JSON.parse(decryptFunction(dataString));

    return {
        id,
        data
    };
};

const isOffline = () => Network.connectionType === Network.ConnectionType.NONE;

class OfflineRequestServiceCall extends ServiceCall {
    /**
     * Creates an OfflineRequestServiceCall helper class
     * If there's no network connection, saves the request to perform later when 
     * network connection is available
     * @augments ServiceCall
     * @param {function} offlineRequestHandler - Gets request options to be modified 
     * when network connection is available and returns a promise
     * @example
     * const { OfflineRequestServiceCall } = require("sf-extension-utils/lib/service-call-offline");
     * sc = new OfflineRequestServiceCall({
     *     baseUrl: "http://smartface.io",
     *     logEnabled: true,
     *     offlineRequestHandler: requestOptions => {
     *         return new Promise((resolve, reject) => {
     *             amce.createRequestOptions(amceOptions)
     *                 .then(({ headers }) => {
     *                     resolve(Object.assign({}, requestOptions, headers));
     *                 });
     *         });
     *     }
     * });
     */
    constructor(options) {
        if (!isConfigured)
            throw Error("First you need to configure");

        super(options);
        this.offlineRequestHandler = options.offlineRequestHandler;
    }

    request(endpointPath, options) {
        const requestOptions = this.createRequestOptions(endpointPath, options);
        if (isOffline()) {
            insertIntoTable(TABLE_NAMES.PENDING_REQUESTS, requestOptions);
            return Promise.resolve(null);
        }
        else {
            return ServiceCall.request(requestOptions);
        }
    }

    /**
     * Perform all pending requests in DB
     * @static
     * @method
     * @returns {Promise} 
     */
    static sendAll() {
        return Promise.resolve().then(() => {
            let getIDsQuery = squel.select()
                .field("id")
                .from(TABLE_NAMES.PENDING_REQUESTS)
                .where("jobid is null")
                .toString();
            let idQuery = database.query(getIDsQuery);
            let idList = getRowsArray(idQuery).map(row => row.getString("id"));
            let promises = [];
            while (idList.length > 0 && !isOffline()) {
                let id = idList.shift();
                let requestRecord = getRecord(TABLE_NAMES.PENDING_REQUESTS, id);
                let jobId = guid();
                let executor = function(id, requestRecord, jobId) {
                    let setJobIdCommand = squel.update()
                        .table(TABLE_NAMES.PENDING_REQUESTS)
                        .set("jobid", jobId)
                        .where("id = ?", id)
                        .toString();
                    execute(() => database.execute(setJobIdCommand));
                    let requestOptions = requestRecord.data;
                    let requestHandlerPromise = this.offlineRequestHandler ?
                        this.offlineRequestHandler(copy(requestOptions)) :
                        Promise.resolve(requestOptions);

                    let serviceCallPromise = requestHandlerPromise
                        .then(handledRequestOptions => {
                            return ServiceCall.request(handledRequestOptions);
                        })
                        .then(response => {
                            let deleteCommand = squel.delete()
                                .from(TABLE_NAMES.PENDING_REQUESTS)
                                .where("id = ?", id)
                                .where("jobid = ?", jobId)
                                .toString();
                            execute(() => database.execute(deleteCommand));
                            return Promise.resolve(response);
                        })
                        .catch(err => {
                            let clearJobCommand = squel.update()
                                .table(TABLE_NAMES.PENDING_REQUESTS)
                                .set("jobid", null)
                                .where("id = ?", id)
                                .toString();
                            execute(() => database.execute(clearJobCommand));
                            return Promise.reject(err);
                        });

                    promises.push(serviceCallPromise);
                }.bind(global, id, requestRecord, jobId);
                executor();
            }
            return Promise.all(promises);
        });
    }

    static clearJobs() {
        return new Promise(resolve => {
            let clearJobsCommand = squel.update()
                .table(TABLE_NAMES.PENDING_REQUESTS)
                .set("jobid", null)
                .toString();
            execute(() => database.execute(clearJobsCommand));
            resolve();
        });
    }
}

class OfflineResponseServiceCall extends ServiceCall {
    /**
     * Creates an OfflineResponseServiceCall helper class
     * 
     * @augments ServiceCall
     * @param {function} requestCleaner - Returns modified request options
     * @param {string} serveFrom - - If "DB" is given, response is served from DB 
     * then request is made to update the DB. - If "API" is given, request is made, 
     * DB is updated with the response then the response is served. - If no network 
     * connection is avaliable, response is served from DB either way.                                                                                             
     * @example
     * const { OfflineResponseServiceCall } = require("sf-extension-utils/lib/service-call-offline");
     * sc = sc || new OfflineResponseServiceCall({
     *     baseUrl: "http://smartface.io",
     *     logEnabled: true,
     *     serveFrom: "DB", // "API"
     *     requestCleaner: requestOptions => {
     *         delete requestOptions.headers;
     *         return requestOptions;
     *     }
     * });     
     */
    constructor(options) {
        if (!isConfigured)
            throw Error("First you need to configure");

        super(options);
        if (options.serveFrom === "DB") // "DB" or "API"
            this.serveFromDB = true;
        this.requestCleaner = options.requestCleaner;
    }

    request(endpointPath, options) {
        const requestOptions = this.createRequestOptions(endpointPath, options);
        let offlineRequest = () => {
            let cleanedRequestOptions = this.requestCleaner ? this.requestCleaner(copy(requestOptions)) : requestOptions;
            let existingRecord = getRecord(TABLE_NAMES.REQUESTS, cleanedRequestOptions);
            if (existingRecord) {
                let responseRecord = getRecord(TABLE_NAMES.RESPONSES, existingRecord.id);
                return Promise.resolve(responseRecord.data);
            }
            else {
                return Promise.reject("No records found");
            }
        };
        let onlineRequest = () => {
            return ServiceCall.request(requestOptions)
                .then(response => {
                    let cleanedRequestOptions = this.requestCleaner ? this.requestCleaner(copy(requestOptions)) : requestOptions;
                    try {
                        let id;
                        let existingRecord = getRecord(TABLE_NAMES.REQUESTS, cleanedRequestOptions);
                        if (existingRecord) {
                            id = existingRecord.id;
                        }
                        else {
                            id = insertIntoTable(TABLE_NAMES.REQUESTS, cleanedRequestOptions);
                        }

                        insertIntoTable(TABLE_NAMES.RESPONSES, response, id);
                        requestOptions.logEnabled && console.info("Successfully stored request & response ", cleanedRequestOptions, response);
                    }
                    catch (ex) {
                        requestOptions.logEnabled && console.error("Failed to store request & response ", cleanedRequestOptions, errorHandler(ex));
                    }
                    return Promise.resolve(response);
                });
        };

        if (this.serveFromDB) {
            return new Promise((resolve, reject) => {
                offlineRequest()
                    .then(e => {
                        resolve(e);
                        onlineRequest(); // For updating db
                    })
                    .catch(e => {
                        onlineRequest()
                            .then(resolve)
                            .catch(reject);
                    });
            });
        }
        else {
            return isOffline() ? offlineRequest() : onlineRequest();
        }
    }
}

const errorHandler = err => {
    if (err instanceof Error)
        return {
            title: err.type || global.lang.applicationError,
            message: System.OS === "Android" ? err.stack : (err.message + "\n\n*" + err.stack)
        };
    else
        return err;
};

const timestamp = () => new Date().toISOString();

/**
 * Configures service-call-offline. Call this in your app once before using any functionality.
 * @function service-call-offline:init
 * @param {object} options configuration options
 * @param {fingerprint:CryptopgyFunction} [options.encryptionFunction] stored data is encrypted with the given function
 * @param {fingerprint:CryptopgyFunction} [options.decryptionFunction] stored data is decrypted with the given function
 * @public
 * @static
 * @example
 * const { init } = require("sf-extension-utils/lib/service-call-offline");
 * const Blob = require('sf-core/blob');
 * 
 * const basicEncrypt = plainData => {
 *     let b = Blob.createFromUTF8String(plainData);
 *     let encryptedData = b.toBase64();
 *     return encryptedData;
 * };
 * 
 * const basicDecrypt = encryptedData => {
 *     let b = Blob.createFromBase64(encryptedData);
 *     let decryptedData = b.toString();
 *     return decryptedData;
 * };
 * 
 * // It is recommended this to be called in app.js:
 * init({
 *     encryptionFunction: basicEncrypt,
 *     decryptionFunction: basicDecrypt
 * });
 * 
 */
function init(options = {}) {
    isConfigured = true;

    encryptFunction = options.encryptionFunction || sameReturner;
    decryptFunction = options.decryptionFunction || sameReturner;

    var notifier = new Network.createNotifier();
    var networkListener = connectionType => {
        if (!isOffline())
            OfflineRequestServiceCall.sendAll();
    };
    networkListener();
    notifier.subscribe(networkListener);
    OfflineRequestServiceCall.clearJobs();
}

/**
 * Drops all tables from offline database
 * @method
 */
function clearOfflineDatabase() {
    return createAsyncTask(() => {
        database.execute(`DROP TABLE ${TABLE_NAMES.REQUESTS}`);
        database.execute(`DROP TABLE ${TABLE_NAMES.RESPONSES}`);
        database.execute(`DROP TABLE ${TABLE_NAMES.PENDING_REQUESTS}`);
    });
}

/**
 * Closes offline database, must be called right before application exits
 * @method
 */
function closeOfflineDatabase() {
    database.close();
}

Object.assign(exports, {
    init,
    OfflineRequestServiceCall,
    OfflineResponseServiceCall,
    clearOfflineDatabase,
    closeOfflineDatabase
});
