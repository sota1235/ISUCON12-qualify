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

