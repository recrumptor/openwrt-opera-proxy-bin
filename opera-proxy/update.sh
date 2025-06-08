#!/bin/bash

# Available:
# amd64,arm,arm64,mips,mips64,mips64le,mipsle
ARCH=mipsle

# Choose specific version
#read -p "Choose version: " VER

# Get latest version
VER="$(curl -fs -o/dev/null -w %{redirect_url} https://github.com/Snawoot/opera-proxy/releases/latest | cut -b 54-)"

echo -e "Downloading binaries... \nVersion: $VER"
curl -LS https://github.com/Snawoot/opera-proxy/releases/download/v$VER/opera-proxy.linux-$ARCH -o files/usr/bin/opera-proxy
chmod +x files/usr/bin/opera-proxy

# Change version in Makefile
sed -i "s/^PKG_VERSION:=.*$/PKG_VERSION:=${VER}/" Makefile
echo "Write the following in the console to compile package:"
echo "make package/opera-proxy/compile"
