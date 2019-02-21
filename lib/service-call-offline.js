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
const SQLite_HARD_LIMIT = 1000000; //https://www.sqlite.org/limits.html
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
const guid = require("./guid");
const Blob = require('sf-core/blob');
const copy = require("./copy");
const TABLE_NAMES = Object.freeze({
    REQUESTS: "requests",
    RESPONSES: "responses",
    PENDING_REQUESTS: "pending"
});

const database = new Database({
    file: dbFile
});

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
        database.execute(query);
    }
};

const insertIntoTable = (tableName, data, /*type,*/ id = guid()) => {
    data = basicEncrypt(JSON.stringify(data));

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
    database.execute("BEGIN TRANSACTION");
    database.execute(deleteRowQuery);
    database.execute(createRowQuery);
    queries.forEach(query => database.execute(query));
    database.execute("COMMIT");
    return id;
};

const createTable = (tableName, extended) => {
    let extendedPart = "";
    if (extended)
        extendedPart = "'jobid' TEXT, ";
    let createTableQuery = `CREATE TABLE IF NOT EXISTS '${tableName}' ('id'	TEXT NOT NULL,'timestamp' TEXT NOT NULL, ${extendedPart}'data0' TEXT, PRIMARY KEY('id'))`;
    database.execute(createTableQuery);
};

Object.keys(TABLE_NAMES).forEach(tableName => createTable(TABLE_NAMES[tableName], tableName === "PENDING_REQUESTS"));

const getRecord = (tableName, requestObjectOrId) => {
    let requestObject, id;
    if (typeof requestObjectOrId !== "string")
        requestObject = basicEncrypt(JSON.stringify(requestObjectOrId));
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
        return queryResult.get(0).getString(column);
    });
    let dataString = dataParts.join("");
    let data = JSON.parse(basicDecrypt(dataString));

    return {
        id,
        data
    };
};

const isOffline = () => Network.connectionType === Network.ConnectionType.NONE;

class OfflineRequestServiceCall extends ServiceCall {
    constructor(options) {
        super(options);
        this.offlineRequestHandler = options.offlineRequestHandler;
        this.encryptFunction = options.encryptFunction || basicEncrypt; // TODO
        this.decryptFunction = options.decryptFunction || basicDecrypt; // TODO
    }

    request(endpointPath, options) {
        const requestOptions = this.createRequestOptions(endpointPath, options);
        if (isOffline()) {
            createAsyncTask(() => {
                    insertIntoTable(TABLE_NAMES.PENDING_REQUESTS, requestOptions);
                })
                .then(() => requestOptions.logEnabled && console.log("Request added as pending ", requestOptions))
                .catch(err => requestOptions.logEnabled && console.error("Failed to add to pending ", err));
            return Promise.resolve(null);
        }
        else {
            return ServiceCall.request(requestOptions);
        }
    }

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
                    database.execute(setJobIdCommand);

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
                            database.execute(deleteCommand);
                            return Promise.resolve(response);
                        })
                        .catch(err => {
                            let clearJobCommand = squel.update()
                                .table(TABLE_NAMES.PENDING_REQUESTS)
                                .set("jobid", null)
                                .where("id = ?", id)
                                .toString();
                            database.execute(clearJobCommand);
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
            database.execute(clearJobsCommand);
            resolve();
        });
    }
}

class OfflineResponseServiceCall extends ServiceCall {
    constructor(options) {
        super(options);
        if (options.serveFrom === "DB") // "DB" or "API"
            this.serveFromDB = true;
        this.requestCleaner = options.requestCleaner;
        this.encryptFunction = options.encryptFunction || basicEncrypt; // TODO
        this.decryptFunction = options.decryptFunction || basicDecrypt; // TODO
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
                    createAsyncTask(() => {
                            let id;
                            let existingRecord = getRecord(TABLE_NAMES.REQUESTS, cleanedRequestOptions);
                            if (existingRecord) {
                                id = existingRecord.id;
                            }
                            else {
                                id = insertIntoTable(TABLE_NAMES.REQUESTS, cleanedRequestOptions);
                            }

                            insertIntoTable(TABLE_NAMES.RESPONSES, response, id);
                        })
                        .then(() => requestOptions.logEnabled && console.log("Request & Response are stored ", cleanedRequestOptions))
                        .catch(err => requestOptions.logEnabled && console.error("Failed to record to request & response ", err));
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

const timestamp = () => new Date().toISOString();

const notifier = new Network.createNotifier();

const networkListener = connectionType => {
    if (!isOffline())
        OfflineRequestServiceCall.sendAll();
};

networkListener();
notifier.subscribe(networkListener);
OfflineRequestServiceCall.clearJobs();

function basicEncrypt(plainData) {
    let b = Blob.createFromUTF8String(plainData);
    let encryptedData = b.toBase64();
    return encryptedData;
}

function basicDecrypt(encryptedData) {
    let b = Blob.createFromBase64(encryptedData);
    let decryptedData = b.toString();
    return decryptedData;
}

function clearOfflineDatabase() {
    return createAsyncTask(() => {
        database.execute(`DROP TABLE ${TABLE_NAMES.REQUESTS}`);
        database.execute(`DROP TABLE ${TABLE_NAMES.RESPONSES}`);
        database.execute(`DROP TABLE ${TABLE_NAMES.PENDING_REQUESTS}`);
    });
}

Object.assign(exports, {
    OfflineRequestServiceCall,
    OfflineResponseServiceCall,
    clearOfflineDatabase
});