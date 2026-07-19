#!/usr/bin/env bash
set -euo pipefail

if [ "${INSTALL_ROS:-false}" != "true" ]; then
  echo "Skipping ROS2 installation."
  exit 0
fi

echo "Installing ROS2 Humble Desktop + Gazebo + RViz..."
sudo apt-get update
sudo apt-get install -y software-properties-common curl
sudo add-apt-repository universe -y

ROS_APT_SOURCE_VERSION=$(curl -s https://api.github.com/repos/ros-infrastructure/ros-apt-source/releases/latest | grep -F "tag_name" | awk -F\" '{print $4}')
# shellcheck source=/dev/null
codename=$(. /etc/os-release && echo "${UBUNTU_CODENAME:-${VERSION_CODENAME}}")
curl -L -o /tmp/ros2-apt-source.deb "https://github.com/ros-infrastructure/ros-apt-source/releases/download/${ROS_APT_SOURCE_VERSION}/ros2-apt-source_${ROS_APT_SOURCE_VERSION}.${codename}_all.deb"
sudo dpkg -i /tmp/ros2-apt-source.deb
sudo apt-get update
sudo apt-get upgrade -y
sudo apt-get install -y ros-humble-desktop ros-dev-tools ros-humble-gazebo-ros-pkgs ros-humble-rviz2 python3-vcstool
