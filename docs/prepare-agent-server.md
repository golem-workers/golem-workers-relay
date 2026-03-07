
### DEPS ###

cat >> /etc/apt/sources.list <<'EOF'
deb http://archive.ubuntu.com/ubuntu noble universe multiverse
deb http://archive.ubuntu.com/ubuntu noble-updates universe multiverse
deb http://security.ubuntu.com/ubuntu noble-security universe multiverse
EOF
apt update
apt install -y ubuntu-keyring

apt update && apt upgrade -y
apt install -y curl gnupg lsb-release jq fail2ban build-essential procps file git wget dbus-user-session nano lsof openssl ca-certificates dnsutils iptables ufw python3 unzip ripgrep

### CHROME ###

wget -q -O /tmp/google-chrome-stable_current_amd64.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
apt install -y /tmp/google-chrome-stable_current_amd64.deb
google-chrome-stable --version


### LOGS ###

sudo sed -i 's/^#SystemMaxUse=.*/SystemMaxUse=100M/' /etc/systemd/journald.conf
sudo sed -i 's/^SystemMaxUse=.*/SystemMaxUse=100M/' /etc/systemd/journald.conf
sudo systemctl restart systemd-journald
sudo journalctl --vacuum-size=100M

#### SWAP ###

sudo fallocate -l 6G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
sudo sysctl vm.swappiness=10
echo 'vm.swappiness=10' | sudo tee -a /etc/sysctl.conf


### DNS / BOOT SPEED FIX ###
set -euo pipefail
sudo systemctl disable --now systemd-resolved || true
sudo systemctl mask systemd-resolved || true
sudo rm -f /etc/resolv.conf
sudo tee /etc/resolv.conf >/dev/null <<'EOF'
nameserver 10.55.0.1
options timeout:1 attempts:2
EOF
sudo chmod 644 /etc/resolv.conf

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

### RELAY PREPULL ###

if [ -d "/root/golem-workers-relay/.git" ]; then
  cd /root/golem-workers-relay
  git fetch --all --prune
  git reset --hard origin/main
else
  rm -rf /root/golem-workers-relay
  git clone https://github.com/golem-workers/golem-workers-relay.git /root/golem-workers-relay
fi

cd /root/golem-workers-relay
npm ci
npm run build
cd ~


### OPENCLAW INSTALL ###

grep -qxF 'export NODE_OPTIONS="--max-old-space-size=2024 --enable-source-maps"' ~/.bashrc || echo 'export NODE_OPTIONS="--max-old-space-size=2024 --enable-source-maps"' >> ~/.bashrc
sudo mkdir -p /etc/systemd/system.conf.d
sudo tee /etc/systemd/system.conf.d/node-options.conf >/dev/null <<'EOF'
[Manager]
DefaultEnvironment="NODE_OPTIONS=--max-old-space-size=2024 --enable-source-maps"
EOF
sudo mkdir -p /etc/systemd/user.conf.d
sudo tee /etc/systemd/user.conf.d/node-options.conf >/dev/null <<'EOF'
[Manager]
DefaultEnvironment="NODE_OPTIONS=--max-old-space-size=2024 --enable-source-maps"
EOF
source ~/.bashrc

curl -fsSL https://openclaw.ai/install.sh | bash -s -- --version 2026.3.1 --install-method npm --no-onboard

export PATH="/home/claw/.npm-global/bin:$PATH"
source ~/.bashrc
sudo -u claw -H bash -lc 'export NPM_CONFIG_PREFIX=/home/claw/.npm-global PATH=/home/claw/.npm-global/bin:$PATH && npm install -g playwright'
sudo -u claw -H bash -lc 'export NPM_CONFIG_PREFIX=/home/claw/.npm-global PATH=/home/claw/.npm-global/bin:$PATH && node -e "console.log(require.resolve(\"playwright/package.json\"))"'
openclaw onboard --install-daemon

