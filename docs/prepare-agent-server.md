
### DEPS ###

cat >> /etc/apt/sources.list <<'EOF'
deb http://archive.ubuntu.com/ubuntu noble universe multiverse
deb http://archive.ubuntu.com/ubuntu noble-updates universe multiverse
deb http://security.ubuntu.com/ubuntu noble-security universe multiverse
EOF
apt update
apt install -y ubuntu-keyring

apt update && apt upgrade -y
apt install -y curl gnupg lsb-release jq fail2ban build-essential procps file git wget dbus-user-session nano


### LOGS ###

sudo sed -i 's/^#SystemMaxUse=.*/SystemMaxUse=100M/' /etc/systemd/journald.conf
sudo sed -i 's/^SystemMaxUse=.*/SystemMaxUse=100M/' /etc/systemd/journald.conf
sudo systemctl restart systemd-journald
sudo journalctl --vacuum-size=100M

#### SWAP ###

sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
sudo sysctl vm.swappiness=10
echo 'vm.swappiness=10' | sudo tee -a /etc/sysctl.conf

### GO ###

wget https://go.dev/dl/go1.25.6.linux-amd64.tar.gz
sudo rm -rf /usr/local/go && sudo tar -C /usr/local -xzf go1.25.6.linux-amd64.tar.gz
sudo cat <<EOF | tee -a ~/.bashrc > /dev/null
export GOROOT=/usr/local/go
export GOPATH=\$HOME/go
export PATH=\$PATH:\$GOROOT/bin:\$GOPATH/bin
EOF
source ~/.bashrc
go version

### BREW ###

id -u linuxbrew >/dev/null 2>&1 || useradd -m -s /bin/bash linuxbrew
mkdir -p /home/linuxbrew/.linuxbrew
chown -R linuxbrew:linuxbrew /home/linuxbrew

sudo -u linuxbrew -H bash -lc 'NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"'
sudo -u linuxbrew -H bash -lc 'grep -qxF '\''eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv bash)"'\'' ~/.bashrc || echo '\''eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv bash)"'\'' >> ~/.bashrc'

cat >/usr/local/bin/brew <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
exec sudo -u linuxbrew -H bash -lc 'cd / && eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv bash)" && brew "$@"' _ "$@"
EOF
chmod +x /usr/local/bin/brew

source /root/.bashrc

brew --version


### OPENCLAW INSTALL ###

echo 'export NODE_OPTIONS="--max-old-space-size=2024"' >> ~/.bashrc
sudo mkdir -p /etc/systemd/system.conf.d
sudo tee /etc/systemd/system.conf.d/node-options.conf >/dev/null <<'EOF'
[Manager]
DefaultEnvironment=NODE_OPTIONS=--max-old-space-size=2024 --enable-source-maps
EOF
sudo mkdir -p /etc/systemd/user.conf.d
sudo tee /etc/systemd/user.conf.d/node-options.conf >/dev/null <<'EOF'
[Manager]
DefaultEnvironment=NODE_OPTIONS=--max-old-space-size=2024 --enable-source-maps
EOF
source ~/.bashrc

curl -fsSL https://openclaw.ai/install.sh | bash -s -- --version 2026.3.1 --install-method npm --no-onboard

export PATH="/home/claw/.npm-global/bin:$PATH"
source ~/.bashrc
openclaw onboard --install-daemon


sudo mkdir -p /etc/systemd/system/golem-workers-relay.service.d && printf '%s\n' '[Service]' 'Environment=NODE_OPTIONS=--max-old-space-size=2024 --enable-source-maps' | sudo tee /etc/systemd/system/golem-workers-relay.service.d/override.conf >/dev/null && sudo systemctl daemon-reload && sudo systemctl restart golem-workers-relay && systemctl show -p Environment golem-workers-relay
sudo mkdir -p /root/.config/systemd/user/openclaw-gateway.service.d
sudo tee /root/.config/systemd/user/openclaw-gateway.service.d/override.conf >/dev/null <<'EOF'
[Service]
Environment=NODE_OPTIONS=--max-old-space-size=2024 --enable-source-maps
EOF
sudo systemctl daemon-reexec
sudo systemctl daemon-reload
sudo systemctl restart golem-workers-relay
sudo -u root XDG_RUNTIME_DIR=/run/user/0 systemctl --user daemon-reexec
sudo -u root XDG_RUNTIME_DIR=/run/user/0 systemctl --user daemon-reload
sudo -u root XDG_RUNTIME_DIR=/run/user/0 systemctl --user restart openclaw-gateway


++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++


mkdir -p ~/Documents/provider-snapshots

scp -i ~/.ssh/do_rsa \
  root@65.21.228.232:/srv/golem-provider/data/overlays/snapshots/img_c4bf8497-b07b-4291-a23e-a9b7c36f7270.overlay \
  ~/Documents/provider-snapshots/