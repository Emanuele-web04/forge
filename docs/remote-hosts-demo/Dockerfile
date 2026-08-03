# A stand-in remote host for Synara: real sshd, real Node, and deliberately NO
# provider credentials — so it demonstrates the "authenticate on the remote host
# first" path that a machine sharing your home directory cannot show.
FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      openssh-server sudo ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /run/sshd

# A non-root user, because the bootstrap installs under $HOME and running the
# remote server as root would not resemble any real deployment.
RUN useradd -m -s /bin/bash synara \
    && echo 'synara ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/synara

# Copy first, then fix ownership AND the parent directory in one layer: sshd
# refuses a key file it cannot reach through a directory it does not trust, and
# a COPY --chown before the mkdir leaves the directory owned by root.
COPY authorized_keys /tmp/authorized_keys
RUN mkdir -p /home/synara/.ssh \
    && mv /tmp/authorized_keys /home/synara/.ssh/authorized_keys \
    && chown -R synara:synara /home/synara/.ssh \
    && chmod 700 /home/synara/.ssh \
    && chmod 600 /home/synara/.ssh/authorized_keys

# Key-only auth, matching how a real host would be reached.
RUN sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config \
    && sed -i 's/^#\?PubkeyAuthentication.*/PubkeyAuthentication yes/' /etc/ssh/sshd_config \
    && sed -i 's/^#\?PermitUserEnvironment.*/PermitUserEnvironment yes/' /etc/ssh/sshd_config

# A non-interactive `ssh host cmd` runs bash without reading .profile or
# .bashrc, so neither `docker run -e` nor a shell rc file reaches it. This is
# the mechanism that does — and it is worth knowing for the real feature too:
# anything Synara starts over SSH gets the login environment, not the one an
# operator has in their own shell.

EXPOSE 22
CMD ["/usr/sbin/sshd", "-D", "-e"]
