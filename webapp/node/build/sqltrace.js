"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.useSqliteTraceHook = void 0;
const fs_1 = require("fs");
const useSqliteTraceHook = (db, filePath) => {
    // これは情報量がたりないので使わない…
    // db.on('profile', (sql: string, nsec: number, extra: any) => {
    //   console.log(sql + ', nsec=' + nsec + ' extra=' + extra)
    // })
    const queryFormat = (before, after, affectedRows, sql, ...params) => {
        return {
            time: before.toISOString(),
            statement: sql.toString(),
            args: params,
            query_time: (after.getTime() - before.getTime()) / 1000,
            affected_rows: affectedRows,
        };
    };
    const writeFile = (log) => {
        const str = JSON.stringify(log, null, 2);
        (0, fs_1.appendFile)(filePath, str + '\n', (error) => {
            if (error) {
                console.error(`warning: failed to write SQLite Log: ${error}`);
            }
        });
    };
    const origGet = db.get.bind(db);
    db.get = async (sql, ...params) => {
        const before = new Date();
        const res = await origGet(sql, ...params);
        const after = new Date();
        const log = queryFormat(before, after, 0, sql, ...params);
        writeFile(log);
        return res;
    };
    const origAll = db.all.bind(db);
    db.all = async (sql, ...params) => {
        const before = new Date();
        const res = await origAll(sql, ...params);
        const after = new Date();
        const log = queryFormat(before, after, 0, sql, ...params);
        writeFile(log);
        return res;
    };
    const origRun = db.run.bind(db);
    db.run = async (sql, ...params) => {
        const before = new Date();
        const res = await origRun(sql, ...params);
        const after = new Date();
        const log = queryFormat(before, after, res.changes ?? 0, sql, ...params);
        writeFile(log);
        return res;
    };
    return db;
};
exports.useSqliteTraceHook = useSqliteTraceHook;
