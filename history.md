# history

```shell
# nginx symbolic link
sudo rm -r /etc/nginx/
sudo ln -s /home/isucon/etc/nginx /etc/nginx
sudo nginx -t
sudo systemctl restart nginx
sudo systemctl status nginx
# systemd symbolic link
sudo cp /etc/systemd/system/isuports.service /home/isucon/etc/systemd # 初回のみ
sudo rm /etc/systemd/system/isuports.service
sudo ln -s /home/isucon/etc/systemd/isuports.service /etc/systemd/system
sudo systemctl daemon-reload
sudo systemctl restart isuports
sudo systemctl status isuports
```
