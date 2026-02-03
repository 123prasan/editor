# Base image with common tools
FROM ubuntu:22.04

# Prevent interactive prompts during install
ENV DEBIAN_FRONTEND=noninteractive

# Install compilers and interpreters
RUN apt-get update && apt-get install -y \
    python3 \
    nodejs \
    g++ \
    default-jdk \
    && rm -rf /var/lib/apt/lists/*

# Set working directory inside container
WORKDIR /app