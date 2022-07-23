"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require('newrelic');
const express_1 = __importDefault(require("express"));
const cookie_parser_1 = __importDefault(require("cookie-parser"));
const body_parser_1 = __importDefault(require("body-parser"));
const multer_1 = __importDefault(require("multer"));
const promise_1 = __importDefault(require("mysql2/promise"));
const child_process_1 = __importDefault(require("child_process"));
const promises_1 = require("fs/promises");
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const util_1 = __importDefault(require("util"));
const path_1 = __importDefault(require("path"));
const sqlite3_1 = __importDefault(require("sqlite3"));
const sqlite_1 = require("sqlite");
const fs_1 = require("fs");
const fs_ext_1 = __importDefault(require("fs-ext"));
const sync_1 = require("csv-parse/sync");
const sqltrace_1 = require("./sqltrace");
const cluster_1 = __importDefault(require("cluster"));
const os_1 = __importDefault(require("os"));
const exec = util_1.default.promisify(child_process_1.default.exec);
const flock = util_1.default.promisify(fs_ext_1.default.flock);
// constants
const initializeScript = '../sql/init.sh';
const cookieName = 'isuports_session';
const RoleAdmin = 'admin';
const RoleOrganizer = 'organizer';
const RolePlayer = 'player';
const RoleNone = 'none';
const tenantNameRegexp = /^[a-z][a-z0-9-]{0,61}[a-z0-9]$/;
// 環境変数を取得する、なければデフォルト値を返す
function getEnv(key, defaultValue) {
    const val = process.env[key];
    if (val !== undefined) {
        return val;
    }
    return defaultValue;
}
// 管理用DBに接続する
const dbConfig = {
    host: process.env['ISUCON_DB_HOST'] ?? '127.0.0.1',
    port: Number(process.env['ISUCON_DB_PORT'] ?? 3306),
    user: process.env['ISUCON_DB_USER'] ?? 'isucon',
    password: process.env['ISUCON_DB_PASSWORD'] ?? 'isucon',
    database: process.env['ISUCON_DB_NAME'] ?? 'isuports',
};
const adminDB = promise_1.default.createPool(dbConfig);
// テナントDBのパスを返す
function tenantDBPath(id) {
    const tenantDBDir = getEnv('ISUCON_TENANT_DB_DIR', '../tenant_db');
    return path_1.default.join(tenantDBDir, `${id.toString()}.db`);
}
// テナントDBに接続する
async function connectToTenantDB(id) {
    const p = tenantDBPath(id);
    let db;
    try {
        db = await (0, sqlite_1.open)({
            filename: p,
            driver: sqlite3_1.default.Database,
        });
        db.configure('busyTimeout', 5000);
        const traceFilePath = getEnv('ISUCON_SQLITE_TRACE_FILE', '');
        if (traceFilePath) {
            db = (0, sqltrace_1.useSqliteTraceHook)(db, traceFilePath);
        }
    }
    catch (error) {
        throw new Error(`failed to open tenant DB: ${error}`);
    }
    return db;
}
// システム全体で一意なIDを生成する
async function dispenseID() {
    return Math.random().toString(32).substring(2);
    /**
    let id = 0
    let lastErr: any
    for (const _ of Array(100)) {
      try {
        const [result] = await adminDB.execute<OkPacket>('REPLACE INTO id_generator (stub) VALUES (?)', ['a'])
  
        id = result.insertId
        break
      } catch (error: any) {
        // deadlock
        if (error.errno && error.errno === 1213) {
          lastErr = error
        }
      }
    }
    if (id !== 0) {
      return id.toString(16)
    }
  
    throw new Error(`error REPLACE INTO id_generator: ${lastErr.toString()}`)
     */
}
// カスタムエラーハンドラにステータスコード拾ってもらうエラー型
class ErrorWithStatus extends Error {
    constructor(status, message) {
        super(message);
        this.name = new.target.name;
        this.status = status;
    }
}
const app = (0, express_1.default)();
app.use(express_1.default.json());
app.use((0, cookie_parser_1.default)());
app.use(body_parser_1.default.urlencoded({ extended: false }));
app.use((_req, res, next) => {
    res.set('Cache-Control', 'private');
    next();
});
app.set('etag', false);
const upload = (0, multer_1.default)();
// see: https://expressjs.com/en/advanced/best-practice-performance.html#handle-exceptions-properly
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);
// リクエストヘッダをパースしてViewerを返す
async function parseViewer(req) {
    const tokenStr = req.cookies[cookieName];
    if (!tokenStr) {
        throw new ErrorWithStatus(401, `cookie ${cookieName} is not found`);
    }
    const keyFilename = getEnv('ISUCON_JWT_KEY_FILE', '../public.pem');
    const cert = await (0, promises_1.readFile)(keyFilename);
    let token;
    try {
        token = jsonwebtoken_1.default.verify(tokenStr, cert, {
            algorithms: ['RS256'],
        });
    }
    catch (error) {
        throw new ErrorWithStatus(401, `${error}`);
    }
    if (!token.sub) {
        throw new ErrorWithStatus(401, `invalid token: subject is not found in token: ${tokenStr}`);
    }
    const subject = token.sub;
    const tr = token['role'];
    if (!tr) {
        throw new ErrorWithStatus(401, `invalid token: role is not found: ${tokenStr}`);
    }
    let role = '';
    switch (tr) {
        case RoleAdmin:
        case RoleOrganizer:
        case RolePlayer:
            role = tr;
            break;
        default:
            throw new ErrorWithStatus(401, `invalid token: invalid role: ${tokenStr}"`);
    }
    // aud は1要素で、テナント名が入っている
    const aud = token.aud;
    if (!aud || aud.length !== 1) {
        throw new ErrorWithStatus(401, `invalid token: aud field is few or too much: ${tokenStr}`);
    }
    const tenant = await retrieveTenantRowFromHeader(req);
    if (!tenant) {
        throw new ErrorWithStatus(401, 'tenant not found');
    }
    if (tenant.name === 'admin' && role !== RoleAdmin) {
        throw new ErrorWithStatus(401, 'tenant not found');
    }
    if (tenant.name !== aud[0]) {
        throw new ErrorWithStatus(401, `invalid token: tenant name is not match with ${req.hostname}: ${tokenStr}`);
    }
    return {
        role: role,
        playerId: subject,
        tenantName: tenant.name,
        tenantId: tenant.id ?? 0,
    };
}
async function retrieveTenantRowFromHeader(req) {
    // JWTに入っているテナント名とHostヘッダのテナント名が一致しているか確認
    const baseHost = getEnv('ISUCON_BASE_HOSTNAME', '.t.isucon.dev');
    const tenantName = req.hostname.replace(baseHost, '');
    // SaaS管理者用ドメイン
    if (tenantName === 'admin') {
        return {
            id: 0,
            name: 'admin',
            display_name: 'admin',
        };
    }
    // テナントの存在確認
    try {
        const [[tenantRow]] = await adminDB.query('SELECT * FROM tenant WHERE name = ?', [
            tenantName,
        ]);
        return tenantRow;
    }
    catch (error) {
        throw new Error(`failed to Select tenant: name=${tenantName}, ${error}`);
    }
}
// 参加者を取得する
async function retrievePlayer(id, columns = ['*']) {
    try {
        const selectRow = columns.join(',');
        const [[playerRow]] = await adminDB.query(`SELECT ${selectRow} FROM player WHERE id = ?`, id);
        return playerRow;
    }
    catch (error) {
        throw new Error(`error Select player: id=${id}, ${error}`);
    }
}
// 参加者を認可する
// 参加者向けAPIで呼ばれる
async function authorizePlayer(id) {
    try {
        const player = await retrievePlayer(id, ['is_disqualified']);
        if (!player) {
            throw new ErrorWithStatus(401, 'player not found');
        }
        if (player.is_disqualified) {
            throw new ErrorWithStatus(403, 'player is disqualified');
        }
        return;
    }
    catch (error) {
        return error;
    }
}
// 大会を取得する
async function retrieveCompetition(id) {
    try {
        const [[competitionRow]] = await adminDB.query('SELECT * FROM competition WHERE id = ?', [id]);
        return competitionRow;
    }
    catch (error) {
        throw new Error(`error Select competition: id=${id}, ${error}`);
    }
}
// 排他ロックのためのファイル名を生成する
function lockFilePath(tenantId) {
    const tenantDBDir = getEnv('ISUCON_TENANT_DB_DIR', '../tenant_db');
    return path_1.default.join(tenantDBDir, `${tenantId}.lock`);
}
async function asyncSleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
// 排他ロックする
async function flockByTenantID(tenantId) {
    const p = lockFilePath(tenantId);
    const fd = (0, fs_1.openSync)(p, 'w+');
    for (;;) {
        try {
            await flock(fd, fs_ext_1.default.constants.LOCK_EX | fs_ext_1.default.constants.LOCK_NB);
        }
        catch (error) {
            if (error.code === 'EAGAIN' && error.errno === 11) {
                await asyncSleep(10);
                continue;
            }
            throw new Error(`error flock: path=${p}, ${error}`);
        }
        break;
    }
    const close = async () => {
        await flock(fd, fs_ext_1.default.constants.LOCK_UN);
        (0, fs_1.closeSync)(fd);
    };
    return close;
}
// SaaS管理者向けAPI
// テナントを追加する
// POST /api/admin/tenants/add
app.post('/api/admin/tenants/add', wrap(async (req, res) => {
    try {
        const viewer = await parseViewer(req);
        if (viewer.tenantName !== 'admin') {
            // admin: SaaS管理者用の特別なテナント名
            throw new ErrorWithStatus(404, `${viewer.tenantName} has not this API`);
        }
        if (viewer.role !== RoleAdmin) {
            throw new ErrorWithStatus(403, 'admin role required');
        }
        const { name, display_name } = req.body;
        if (!validateTenantName(name)) {
            throw new ErrorWithStatus(400, `invalid tenant name: ${name}`);
        }
        const now = Math.floor(new Date().getTime() / 1000);
        let id;
        try {
            const [result] = await adminDB.execute('INSERT INTO tenant (name, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)', [name, display_name, now, now]);
            id = result.insertId;
        }
        catch (error) {
            // duplicate entry
            if (error.errno && error.errno === 1062) {
                throw new ErrorWithStatus(400, 'duplicate tenant');
            }
            throw new Error(`error Insert tenant: name=${name}, displayName=${display_name}, createdAt=${now}, updatedAt=${now}, ${error}`);
        }
        const data = {
            tenant: {
                id: id.toString(),
                name,
                display_name,
                billing: 0,
            },
        };
        res.status(200).json({
            status: true,
            data,
        });
    }
    catch (error) {
        if (error.status) {
            throw error; // rethrow
        }
        throw new ErrorWithStatus(500, error);
    }
}));
// テナント名が規則に沿っているかチェックする
function validateTenantName(name) {
    if (name.match(tenantNameRegexp)) {
        return true;
    }
    return false;
}
// 大会ごとの課金レポートを計算する
async function billingReportByCompetition(tenantId, competitionId) {
    const comp = await retrieveCompetition(competitionId);
    if (!comp) {
        throw Error('error retrieveCompetition on billingReportByCompetition');
    }
    // ランキングにアクセスした参加者のIDを取得する
    /**
    const [vhs] = await adminDB.query<(VisitHistorySummaryRow & RowDataPacket)[]>(
      'SELECT player_id, created_at AS min_created_at FROM first_visit_history WHERE tenant_id = ? AND competition_id = ? GROUP BY player_id',
      [tenantId, comp.id]
    )
     */
    const [vhs] = await adminDB.query('SELECT player_id, MIN(created_at) AS min_created_at FROM visit_history WHERE tenant_id = ? AND competition_id = ? GROUP BY player_id', [tenantId, comp.id]);
    const billingMap = {};
    for (const vh of vhs) {
        // competition.finished_atよりもあとの場合は、終了後に訪問したとみなして大会開催内アクセス済みとみなさない
        if (comp.finished_at !== null && comp.finished_at < vh.min_created_at) {
            continue;
        }
        billingMap[vh.player_id] = 'visitor';
    }
    // player_scoreを読んでいるときに更新が走ると不整合が起こるのでロックを取得する
    const unlock = await flockByTenantID(tenantId);
    try {
        // スコアを登録した参加者のIDを取得する
        const [scoredPlayerIds] = await adminDB.query('SELECT DISTINCT(player_id) FROM player_score WHERE tenant_id = ? AND competition_id = ?', [tenantId, comp.id]);
        for (const pid of scoredPlayerIds) {
            // スコアが登録されている参加者
            billingMap[pid.player_id] = 'player';
        }
        // 大会が終了している場合のみ請求金額が確定するので計算する
        const counts = {
            player: 0,
            visitor: 0,
        };
        if (comp.finished_at) {
            for (const category of Object.values(billingMap)) {
                switch (category) {
                    case 'player':
                        counts.player++;
                        break;
                    case 'visitor':
                        counts.visitor++;
                        break;
                }
            }
        }
        return {
            competition_id: comp.id,
            competition_title: comp.title,
            player_count: counts.player,
            visitor_count: counts.visitor,
            billing_player_yen: 100 * counts.player,
            billing_visitor_yen: 10 * counts.visitor,
            billing_yen: 100 * counts.player + 10 * counts.visitor,
        };
    }
    catch (error) {
        throw new Error(`error Select count player_score: tenantId=${tenantId}, competitionId=${comp.id}, ${error}`);
    }
    finally {
        unlock();
    }
}
// SaaS管理者用API
// テナントごとの課金レポートを最大10件、テナントのid降順で取得する
// GET /api/admin/tenants/billing
// URL引数beforeを指定した場合、指定した値よりもidが小さいテナントの課金レポートを取得する
app.get('/api/admin/tenants/billing', wrap(async (req, res) => {
    try {
        if (req.hostname !== getEnv('ISUCON_ADMIN_HOSTNAME', 'admin.t.isucon.dev')) {
            throw new ErrorWithStatus(404, `invalid hostname ${req.hostname}`);
        }
        const viewer = await parseViewer(req);
        if (viewer.role !== RoleAdmin) {
            throw new ErrorWithStatus(403, 'admin role required');
        }
        const before = req.query.before;
        const beforeId = before ? parseInt(before, 10) : 0;
        if (isNaN(beforeId)) {
            throw new ErrorWithStatus(400, `failed to parse query parameter 'before'=${before}`);
        }
        // テナントごとに
        //   大会ごとに
        //     scoreに登録されているplayerでアクセスした人 * 100
        //     scoreに登録されていないplayerでアクセスした人 * 10
        //   を合計したものを
        // テナントの課金とする
        const ts = [];
        const tenantBillings = [];
        try {
            const [tenants] = await adminDB.query('SELECT * FROM tenant ORDER BY id DESC');
            ts.push(...tenants);
        }
        catch (error) {
            throw new Error(`error Select tenant: ${error}`);
        }
        for (const tenant of ts) {
            if (beforeId !== 0 && beforeId <= tenant.id) {
                continue;
            }
            const tb = {
                id: tenant.id.toString(),
                name: tenant.name,
                display_name: tenant.display_name,
                billing: 0,
            };
            const [competitions] = await adminDB.query('SELECT * FROM competition WHERE tenant_id = ?', [tenant.id]);
            for (const comp of competitions) {
                const report = await billingReportByCompetition(tenant.id, comp.id);
                tb.billing += report.billing_yen;
            }
            tenantBillings.push(tb);
            if (tenantBillings.length >= 10) {
                break;
            }
        }
        res.status(200).json({
            status: true,
            data: {
                tenants: tenantBillings,
            },
        });
    }
    catch (error) {
        if (error.status) {
            throw error; // rethrow
        }
        throw new ErrorWithStatus(500, error);
    }
}));
// テナント管理者向けAPI - 参加者追加、一覧、失格
// テナント管理者向けAPI
// GET /api/organizer/players
// 参加者一覧を返す
app.get('/api/organizer/players', wrap(async (req, res) => {
    try {
        const viewer = await parseViewer(req);
        if (viewer.role !== RoleOrganizer) {
            throw new ErrorWithStatus(403, 'role organizer required');
        }
        const pds = [];
        try {
            const [pls] = await adminDB.query('SELECT * FROM player WHERE tenant_id = ? ORDER BY created_at DESC', [viewer.tenantId]);
            pds.push(...pls.map((player) => ({
                id: player.id,
                display_name: player.display_name,
                is_disqualified: !!player.is_disqualified,
            })));
        }
        catch (error) {
            throw new Error(`error Select player, tenant_id=${viewer.tenantId}: ${error}`);
        }
        const data = {
            players: pds,
        };
        res.status(200).json({
            status: true,
            data,
        });
    }
    catch (error) {
        if (error.status) {
            throw error; // rethrow
        }
        throw new ErrorWithStatus(500, error);
    }
}));
app.post('/api/organizer/players/add', wrap(async (req, res) => {
    try {
        const viewer = await parseViewer(req);
        if (viewer.role !== RoleOrganizer) {
            throw new ErrorWithStatus(403, 'role organizer required');
        }
        const pds = [];
        const displayNames = req.body['display_name[]'];
        for (const displayName of displayNames) {
            const id = await dispenseID();
            const now = Math.floor(new Date().getTime() / 1000);
            try {
                await adminDB.query('INSERT INTO player (id, tenant_id, display_name, is_disqualified, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', [id,
                    viewer.tenantId,
                    displayName,
                    false,
                    now,
                    now]);
            }
            catch (error) {
                throw new Error(`error Insert player at tenantDB: tenantId=${viewer.tenantId} id=${id}, displayName=${displayName}, isDisqualified=false, createdAt=${now}, updatedAt=${now}, ${error}`);
            }
            const player = await retrievePlayer(id, ['id', 'display_name', 'is_disqualified']);
            if (!player) {
                throw new Error('error retrievePlayer id=${id}');
            }
            pds.push({
                id: player.id,
                display_name: player.display_name,
                is_disqualified: !!player.is_disqualified,
            });
        }
        const data = {
            players: pds,
        };
        res.status(200).json({
            status: true,
            data,
        });
    }
    catch (error) {
        if (error.status) {
            throw error; // rethrow
        }
        throw new ErrorWithStatus(500, error);
    }
}));
// テナント管理者向けAPI
// POST /api/organizer/player/:player_id/disqualified
// 参加者を失格にする
app.post('/api/organizer/player/:playerId/disqualified', wrap(async (req, res) => {
    try {
        const viewer = await parseViewer(req);
        if (viewer.role !== RoleOrganizer) {
            throw new ErrorWithStatus(403, 'role organizer required');
        }
        const { playerId } = req.params;
        if (!playerId) {
            throw new ErrorWithStatus(400, 'player_id is required');
        }
        const now = Math.floor(new Date().getTime() / 1000);
        let pd;
        try {
            try {
                await adminDB.query('UPDATE player SET is_disqualified = ?, updated_at = ? WHERE id = ?', [true, now, playerId]);
            }
            catch (error) {
                throw new Error(`error Update player: isDisqualified=true, updatedAt=${now}, id=${playerId}, ${error}`);
            }
            const player = await retrievePlayer(playerId, ['id', 'display_name', 'is_disqualified']);
            if (!player) {
                // 存在しないプレイヤー
                throw new ErrorWithStatus(404, 'player not found');
            }
            pd = {
                id: player.id,
                display_name: player.display_name,
                is_disqualified: !!player.is_disqualified,
            };
        }
        catch (error) {
            if (error.status) {
                throw error; // rethrow
            }
            throw error;
        }
        const data = {
            player: pd,
        };
        res.status(200).json({
            status: true,
            data,
        });
    }
    catch (error) {
        if (error.status) {
            throw error; // rethrow
        }
        throw new ErrorWithStatus(500, error);
    }
}));
// テナント管理者向けAPI - 大会管理
// テナント管理者向けAPI
// POST /api/organizer/competitions/add
// 大会を追加する
app.post('/api/organizer/competitions/add', wrap(async (req, res) => {
    try {
        const viewer = await parseViewer(req);
        if (viewer.role !== RoleOrganizer) {
            throw new ErrorWithStatus(403, 'role organizer required');
        }
        const { title } = req.body;
        const now = Math.floor(new Date().getTime() / 1000);
        const id = await dispenseID();
        try {
            await adminDB.query('INSERT INTO competition (id, tenant_id, title, finished_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', [id,
                viewer.tenantId,
                title,
                null,
                now,
                now]);
        }
        catch (error) {
            throw new Error(`error Insert competition: id=${id}, tenant_id=${viewer.tenantId}, title=${title}, finishedAt=null, createdAt=${now}, updatedAt=${now}, ${error}`);
        }
        const data = {
            competition: {
                id,
                title,
                is_finished: false,
            },
        };
        res.status(200).json({
            status: true,
            data,
        });
    }
    catch (error) {
        if (error.status) {
            throw error; // rethrow
        }
        throw new ErrorWithStatus(500, error);
    }
}));
// テナント管理者向けAPI
// POST /api/organizer/competition/:competition_id/finish
// 大会を終了する
app.post('/api/organizer/competition/:competitionId/finish', wrap(async (req, res) => {
    try {
        const viewer = await parseViewer(req);
        if (viewer.role !== RoleOrganizer) {
            throw new ErrorWithStatus(403, 'role organizer required');
        }
        const { competitionId } = req.params;
        if (!competitionId) {
            throw new ErrorWithStatus(400, 'competition_id required');
        }
        const now = Math.floor(new Date().getTime() / 1000);
        const competition = await retrieveCompetition(competitionId);
        if (!competition) {
            throw new ErrorWithStatus(404, 'competition not found');
        }
        await adminDB.query('UPDATE competition SET finished_at = ?, updated_at = ? WHERE id = ?', [now,
            now,
            competitionId]);
        res.status(200).json({
            status: true,
        });
    }
    catch (error) {
        if (error.status) {
            throw error; // rethrow
        }
        throw new ErrorWithStatus(500, error);
    }
}));
// テナント管理者向けAPI
// POST /api/organizer/competition/:competitionId/score
// 大会のスコアをCSVでアップロードする
app.post('/api/organizer/competition/:competitionId/score', upload.single('scores'), wrap(async (req, res) => {
    try {
        const viewer = await parseViewer(req);
        if (viewer.role !== RoleOrganizer) {
            throw new ErrorWithStatus(403, 'role organizer required');
        }
        const { competitionId } = req.params;
        if (!competitionId) {
            throw new ErrorWithStatus(400, 'competition_id required');
        }
        const playerScoreRows = [];
        try {
            const competition = await retrieveCompetition(competitionId);
            if (!competition) {
                throw new ErrorWithStatus(404, 'competition not found');
            }
            if (competition.finished_at) {
                return res.status(400).json({
                    status: false,
                    message: 'competition is finished',
                });
            }
            const file = req.file;
            if (!file) {
                throw new Error('error form[scores] is not specified');
            }
            const buf = req.file?.buffer;
            if (!buf) {
                throw new Error('error form[scores] has no data');
            }
            const records = (0, sync_1.parse)(buf.toString(), {
                columns: true,
                skip_empty_lines: true,
            });
            const recordKeys = Object.keys(records[0]);
            if (recordKeys.length !== 2 || recordKeys[0] !== 'player_id' || recordKeys[1] !== 'score') {
                throw new ErrorWithStatus(400, 'invalid CSV headers');
            }
            // DELETEしたタイミングで参照が来ると空っぽのランキングになるのでロックする
            const unlock = await flockByTenantID(viewer.tenantId);
            let rowNum = 0;
            try {
                for (const record of records) {
                    rowNum++;
                    const keys = Object.keys(record);
                    if (keys.length !== 2) {
                        throw new Error('row must have two columns ${record}');
                    }
                    const { player_id, score: scoreStr } = record;
                    const p = await retrievePlayer(player_id, ['id']);
                    if (!p) {
                        // 存在しない参加者が含まれている
                        throw new ErrorWithStatus(400, `player not found: ${player_id}`);
                    }
                    const score = parseInt(scoreStr, 10);
                    if (isNaN(score)) {
                        throw new ErrorWithStatus(400, `error parseInt: scoreStr=${scoreStr}`);
                    }
                    const id = await dispenseID();
                    const now = Math.floor(new Date().getTime() / 1000);
                    playerScoreRows.push({
                        id,
                        tenant_id: viewer.tenantId,
                        player_id,
                        competition_id: competitionId,
                        score: score,
                        row_num: rowNum,
                        created_at: now,
                        updated_at: now,
                    });
                }
                await adminDB.query('DELETE FROM player_score WHERE tenant_id = ? AND competition_id = ?', [viewer.tenantId,
                    competitionId]);
                for (const row of playerScoreRows) {
                    await adminDB.query('INSERT INTO player_score (id, tenant_id, player_id, competition_id, score, row_num, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
                        row.id,
                        row.tenant_id,
                        row.player_id,
                        row.competition_id,
                        row.score,
                        row.row_num,
                        row.created_at,
                        row.updated_at,
                    ]);
                }
            }
            finally {
                unlock();
            }
        }
        catch (error) {
            if (error.status) {
                throw error; // rethrow
            }
            throw error;
        }
        const data = {
            rows: playerScoreRows.length,
        };
        res.status(200).json({
            status: true,
            data,
        });
    }
    catch (error) {
        if (error.status) {
            throw error; // rethrow
        }
        throw new ErrorWithStatus(500, error);
    }
}));
// テナント管理者向けAPI
// GET /api/organizer/billing
// テナント内の課金レポートを取得する
app.get('/api/organizer/billing', wrap(async (req, res) => {
    try {
        const viewer = await parseViewer(req);
        if (viewer.role !== RoleOrganizer) {
            throw new ErrorWithStatus(403, 'role organizer required');
        }
        const reports = [];
        const [competitions] = await adminDB.query('SELECT * FROM competition WHERE tenant_id=? ORDER BY created_at DESC', [viewer.tenantId]);
        for (const comp of competitions) {
            const report = await billingReportByCompetition(viewer.tenantId, comp.id);
            reports.push(report);
        }
        const data = {
            reports,
        };
        res.status(200).json({
            status: true,
            data,
        });
    }
    catch (error) {
        if (error.status) {
            throw error; // rethrow
        }
        throw new ErrorWithStatus(500, error);
    }
}));
async function competitionsHandler(req, res, viewer) {
    try {
        const [competitions] = await adminDB.query('SELECT * FROM competition WHERE tenant_id = ? ORDER BY created_at DESC', [viewer.tenantId]);
        const cds = competitions.map((comp) => ({
            id: comp.id,
            title: comp.title,
            is_finished: !!comp.finished_at,
        }));
        const data = {
            competitions: cds,
        };
        res.status(200).json({
            status: true,
            data,
        });
    }
    catch (error) {
        if (error.status) {
            throw error; // rethrow
        }
        throw new ErrorWithStatus(500, error);
    }
}
// テナント管理者向けAPI
// GET /api/organizer/competitions
// 大会の一覧を取得する
app.get('/api/organizer/competitions', wrap(async (req, res) => {
    try {
        const viewer = await parseViewer(req);
        if (viewer.role !== RoleOrganizer) {
            throw new ErrorWithStatus(403, 'role organizer required');
        }
        await competitionsHandler(req, res, viewer);
    }
    catch (error) {
        if (error.status) {
            throw error; // rethrow
        }
        throw new ErrorWithStatus(500, error);
    }
}));
// 参加者向けAPI
// GET /api/player/player/:playerId
// 参加者の詳細情報を取得する
app.get('/api/player/player/:playerId', wrap(async (req, res) => {
    try {
        const viewer = await parseViewer(req);
        if (viewer.role !== RolePlayer) {
            throw new ErrorWithStatus(403, 'role player required');
        }
        const { playerId } = req.params;
        if (!playerId) {
            throw new ErrorWithStatus(400, 'player_id is required');
        }
        let pd;
        const psds = [];
        const error = await authorizePlayer(viewer.playerId);
        if (error) {
            throw error;
        }
        const p = await retrievePlayer(playerId, ['id', 'display_name', 'is_disqualified']);
        if (!p) {
            throw new ErrorWithStatus(404, 'player not found');
        }
        pd = {
            id: p.id,
            display_name: p.display_name,
            is_disqualified: !!p.is_disqualified,
        };
        const [competitionScores] = await adminDB.query('SELECT t1.id    as competition_id,\n' +
            '       t2.score as score\n' +
            'FROM competition as t1\n' +
            '         left join player_score t2 on t1.tenant_id = t2.tenant_id and t1.id = t2.competition_id\n' +
            'WHERE t1.tenant_id = ?\n' +
            '  and t2.player_id = ?\n' +
            'ORDER BY created_at ASC\n', [viewer.tenantId, p.id]);
        // player_scoreを読んでいるときに更新が走ると不整合が起こるのでロックを取得する
        const unlock = await flockByTenantID(viewer.tenantId);
        try {
            for (const ps of competitionScores) {
                const comp = await retrieveCompetition(ps.competition_id);
                if (!comp) {
                    throw new Error('error retrieveCompetition');
                }
                psds.push({
                    competition_title: comp?.title,
                    score: ps.score,
                });
            }
        }
        finally {
            unlock();
        }
        const data = {
            player: pd,
            scores: psds,
        };
        res.status(200).json({
            status: true,
            data,
        });
    }
    catch (error) {
        if (error.status) {
            throw error; // rethrow
        }
        throw new ErrorWithStatus(500, error);
    }
}));
// 参加者向けAPI
// GET /api/player/competition/:competitionId/ranking
// 大会ごとのランキングを取得する
app.get('/api/player/competition/:competitionId/ranking', wrap(async (req, res) => {
    try {
        const viewer = await parseViewer(req);
        if (viewer.role !== RolePlayer) {
            throw new ErrorWithStatus(403, 'role player required');
        }
        const { competitionId } = req.params;
        if (!competitionId) {
            throw new ErrorWithStatus(400, 'competition_id is required');
        }
        let cd;
        const ranks = [];
        const error = await authorizePlayer(viewer.playerId);
        if (error) {
            throw error;
        }
        const competition = await retrieveCompetition(competitionId);
        if (!competition) {
            throw new ErrorWithStatus(404, 'competition not found');
        }
        cd = {
            id: competition.id,
            title: competition.title,
            is_finished: !!competition.finished_at,
        };
        const now = Math.floor(new Date().getTime() / 1000);
        const [[tenant]] = await adminDB.query('SELECT * FROM tenant WHERE id = ?', [
            viewer.tenantId,
        ]);
        try {
            /**
             await adminDB.execute<OkPacket>(
             'INSERT INTO first_visit_history (player_id, tenant_id, competition_id, created_at) VALUES (?, ?, ?, ?)',
             [viewer.playerId, tenant.id, competitionId, now]
             )
             */
            await adminDB.execute('INSERT INTO visit_history (player_id, tenant_id, competition_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', [viewer.playerId, tenant.id, competitionId, now, now]);
        }
        catch (err) {
            // TODO: catch duplicate error
        }
        const { rank_after: rankAfterStr } = req.query;
        let rankAfter;
        if (rankAfterStr) {
            rankAfter = parseInt(rankAfterStr.toString(), 10);
        }
        // player_scoreを読んでいるときに更新が走ると不整合が起こるのでロックを取得する
        const unlock = await flockByTenantID(tenant.id);
        try {
            const [pss] = await adminDB.query('SELECT\n' +
                '    player_score.score as score,\n' +
                '    player_score.row_num as row_num,\n' +
                '    player.id as player_id,\n' +
                '    player.display_name as display_name\n' +
                'FROM player_score\n' +
                '         left join player on player_score.player_id = player.id\n' +
                'WHERE player_score.tenant_id = ?\n' +
                '  AND player_score.competition_id = ?\n' +
                'ORDER BY player_score.row_num DESC', [tenant.id,
                competition.id]);
            const scoredPlayerSet = {};
            const tmpRanks = [];
            for (const ps of pss) {
                // player_scoreが同一player_id内ではrow_numの降順でソートされているので
                // 現れたのが2回目以降のplayer_idはより大きいrow_numでスコアが出ているとみなせる
                if (scoredPlayerSet[ps.player_id]) {
                    continue;
                }
                scoredPlayerSet[ps.player_id] = 1;
                tmpRanks.push({
                    rank: 0,
                    score: ps.score,
                    player_id: ps.player_id,
                    player_display_name: ps.display_name,
                    row_num: ps.row_num,
                });
            }
            tmpRanks.sort((a, b) => {
                if (a.score === b.score) {
                    return a.row_num < b.row_num ? -1 : 1;
                }
                return a.score > b.score ? -1 : 1;
            });
            tmpRanks.forEach((rank, index) => {
                if (index < rankAfter)
                    return;
                if (ranks.length >= 100)
                    return;
                ranks.push({
                    rank: index + 1,
                    score: rank.score,
                    player_id: rank.player_id,
                    player_display_name: rank.player_display_name,
                });
            });
        }
        finally {
            unlock();
        }
        const data = {
            competition: cd,
            ranks,
        };
        res.status(200).json({
            status: true,
            data,
        });
    }
    catch (error) {
        if (error.status) {
            throw error; // rethrow
        }
        throw new ErrorWithStatus(500, error);
    }
}));
// 参加者向けAPI
// GET /api/player/competitions
// 大会の一覧を取得する
app.get('/api/player/competitions', wrap(async (req, res) => {
    try {
        const viewer = await parseViewer(req);
        if (viewer.role !== RolePlayer) {
            throw new ErrorWithStatus(403, 'role player required');
        }
        const error = await authorizePlayer(viewer.playerId);
        if (error) {
            throw error;
        }
        await competitionsHandler(req, res, viewer);
    }
    catch (error) {
        if (error.status) {
            throw error; // rethrow
        }
        throw new ErrorWithStatus(500, error);
    }
}));
// 共通API
// GET /api/me
// JWTで認証した結果、テナントやユーザ情報を返す
app.get('/api/me', wrap(async (req, res) => {
    try {
        const tenant = await retrieveTenantRowFromHeader(req);
        if (!tenant) {
            throw new ErrorWithStatus(500, 'tenant not found');
        }
        const td = {
            name: tenant.name,
            display_name: tenant.display_name,
        };
        const viewer = await parseViewer(req);
        if (viewer.role === RoleAdmin || viewer.role === RoleOrganizer) {
            const data = {
                tenant: td,
                me: null,
                role: viewer.role,
                logged_in: true,
            };
            return res.status(200).json({
                status: true,
                data,
            });
        }
        const p = await retrievePlayer(viewer.playerId, ['id', 'display_name', 'is_disqualified']);
        if (!p) {
            const data = {
                tenant: td,
                me: null,
                role: RoleNone,
                logged_in: false,
            };
            return res.status(200).json({
                status: true,
                data,
            });
        }
        const data = {
            tenant: td,
            me: {
                id: p.id,
                display_name: p.display_name,
                is_disqualified: !!p.is_disqualified,
            },
            role: viewer.role,
            logged_in: true,
        };
        return res.status(200).json({
            statu: true,
            data,
        });
    }
    catch (error) {
        if (error.status) {
            throw error; // rethrow
        }
        throw new ErrorWithStatus(500, error);
    }
}));
async function moveToMysqlFromSqlite() {
    for (let i = 1; i <= 100; i++) {
        const tenantDB = await connectToTenantDB(i);
        const competitions = await tenantDB.all('SELECT * FROM competition');
        const promises = [];
        for (const c of competitions) {
            promises.push(adminDB.query('INSERT INTO competition (id, tenant_id, title, finished_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', [c['id'], c['tenant_id'], c['title'], c['finished_at'], c['created_at'], c['updated_at']]));
        }
        const players = await tenantDB.all('SELECT * FROM player');
        for (const p of players) {
            promises.push(adminDB.query('INSERT INTO player (id, tenant_id, display_name, is_disqualified, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', [p['id'], p['tenant_id'], p['display_name'], p['is_disqualified'], p['created_at'], p['updated_at']]));
        }
        const playerScores = await tenantDB.all('select id,\n' +
            '       t1.tenant_id,\n' +
            '       t1.competition_id,\n' +
            '       t1.player_id,\n' +
            '       score,\n' +
            '       row_num,\n' +
            '       created_at,\n' +
            '       updated_at\n' +
            'from player_score as t1\n' +
            '         join (select tenant_id, competition_id, player_id, max(row_num) as max_row_num\n' +
            '               from player_score as t2\n' +
            '               group by tenant_id, competition_id, player_id) as t3\n' +
            '              on t1.tenant_id = t3.tenant_id and t1.competition_id = t3.competition_id and\n' +
            '                 t1.player_id = t3.player_id and t1.row_num = t3.max_row_num');
        for (const ps of playerScores) {
            promises.push(adminDB.query('INSERT INTO player_score (id, tenant_id, player_id, competition_id, score, row_num, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [ps['id'], ps['tenant_id'], ps['player_id'], ps['competition_id'], ps['score'], ps['row_num'], ps['created_at'], ps['updated_at']]));
        }
        await Promise.all(promises);
    }
}
app.post('/initialize_data', wrap(async (req, res, _next) => {
    await moveToMysqlFromSqlite();
}));
// ベンチマーカー向けAPI
// POST /initialize
// ベンチマーカーが起動したときに最初に呼ぶ
// データベースの初期化などが実行されるため、スキーマを変更した場合などは適宜改変すること
app.post('/initialize', wrap(async (req, res, _next) => {
    try {
        await exec(initializeScript);
        const data = {
            lang: 'node',
        };
        res.status(200).json({
            status: true,
            data,
        });
    }
    catch (error) {
        throw new ErrorWithStatus(500, `initialize failed: ${error}`);
    }
}));
// エラー処理関数
app.use((err, req, res, _next) => {
    console.error('error occurred: status=' + err.status + ' reason=' + err.message);
    res.status(err.status).json({
        status: false,
    });
});
const port = getEnv('SERVER_APP_PORT', '3000');
console.log('starting isuports server on :' + port + ' ...');
const totalCPUs = os_1.default.cpus().length;
if (cluster_1.default.isMaster) {
    console.log(`Number of CPUs is ${totalCPUs}`);
    console.log(`Master ${process.pid} is running`);
    for (let i = 0; i < totalCPUs; i++) {
        cluster_1.default.fork();
    }
    cluster_1.default.on("exit", (worker, code, signal) => {
        console.log(`worker ${worker.process.pid} died`);
        console.log(`Now forking another worker`);
        cluster_1.default.fork();
    });
}
else {
    console.log(`Worker ${process.pid} started`);
    app.listen(parseInt(process.env["SERVER_APP_PORT"] ?? "3000", 10));
}
