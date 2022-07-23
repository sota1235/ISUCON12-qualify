# history

```shell
# nginx symbolic link
sudo rm -r /etc/nginx/
sudo ln -s /home/isucon/etc/nginx /etc/nginx
sudo nginx -t
sudo systemctl restart nginx
sudo systemctl status nginx
```
