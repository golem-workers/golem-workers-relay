
### DEPS ###

cat >> /etc/apt/sources.list <<'EOF'
deb http://archive.ubuntu.com/ubuntu noble universe multiverse
deb http://archive.ubuntu.com/ubuntu noble-updates universe multiverse
deb http://security.ubuntu.com/ubuntu noble-security universe multiverse
EOF
apt update
apt install -y ubuntu-keyring

apt update && apt upgrade -y
apt install -y curl gnupg lsb-release jq fail2ban build-essential procps file git wget dbus-user-session


### LOGS ###

sudo sed -i 's/^#SystemMaxUse=.*/SystemMaxUse=100M/' /etc/systemd/journald.conf
sudo sed -i 's/^SystemMaxUse=.*/SystemMaxUse=100M/' /etc/systemd/journald.conf
sudo systemctl restart systemd-journald
sudo journalctl --vacuum-size=100M

### F2B ###

sudo tee /etc/fail2ban/jail.local > /dev/null <<EOF
[DEFAULT]
ignoreip = 127.0.0.1/8 ::1 192.168.2.0/24
banaction = ufw
maxretry = 30
findtime = 3600
bantime  = 86400

[sshd]
enabled = true
port = ssh
filter = sshd
logpath = /var/log/auth.log
EOF

sudo systemctl restart fail2ban

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



### USER ###

sudo bash -c 'useradd -m -s /bin/bash claw && passwd -l claw && echo "claw ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/claw && chmod 440 /etc/sudoers.d/claw && sed -i "s/^#*PasswordAuthentication.*/PasswordAuthentication no/" /etc/ssh/sshd_config && systemctl restart ssh'
apt install -y dbus-user-session
loginctl enable-linger claw
systemctl restart "user@$(id -u claw).service"

cd /home/claw/
sudo -iu claw

__________________________________________________________________________________

echo 'export XDG_RUNTIME_DIR="/run/user/$(id -u)"' >> ~/.bashrc
echo 'export DBUS_SESSION_BUS_ADDRESS="unix:path=${XDG_RUNTIME_DIR}/bus"' >> ~/.bashrc
source ~/.bashrc

### BREW ###

NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
echo >> /home/claw/.bashrc
echo 'eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv bash)"' >> /home/claw/.bashrc
eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv bash)"

brew --version


### OPENCLAW INSTALL ###

echo 'export NODE_OPTIONS="--max-old-space-size=2024"' >> ~/.bashrc
source ~/.bashrc
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method npm --no-onboard

export PATH="/home/claw/.npm-global/bin:$PATH"
source ~/.bashrc
openclaw onboard --install-daemon

