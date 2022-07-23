#!/bin/bash

set -x

make deploy SSH_NAME=isu1
make deploy SSH_NAME=isu2
make deploy SSH_NAME=isu3

echo "全サーバにデプロイしました `git rev-parse HEAD` by `git config user.name`" | notify_slack -c ./tools/notify_slack/notify_slack.toml
