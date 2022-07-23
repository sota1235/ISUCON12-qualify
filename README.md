# ISUCON12 qualify

## Links

- [Portal](https://portal.isucon.net/)

## Makefile usage

If you want to use commands for specific ssh client, you can use `SSH_NAME`.

```shell
make deploy SSH_NAME=isu1
```

You can specify git branch name by use `GIT_BRANCH`

```shell
make deploy GIT_BRANCH=feature-nplus1
```

## ローカル起動

ISUCON12-qualify ディレクトリで以下を順に実行。

initial_data をコピー

```
scp -r isu1:initial_data .
```

mysql 起動

```
docker-compose up -d
```

```
cd webapp/node
npm ci # 初回だけ
RUN_LOCAL=TRUE ISUCON_DB_NAME=isuports npm run serve
```

初期化

```
curl -X POST localhost:3000/initialize
```

TODO: 認証
TODO: public ファイル
