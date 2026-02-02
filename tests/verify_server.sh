
#!/bin/bash
# verify_server.sh

echo "Waiting for port 8080..."
for i in {1..10}; do
    nc -z 127.0.0.1 8080 && break
    sleep 1
done

echo "Sending request..."
curl -v -X POST http://127.0.0.1:8080/copilotkit \
     -H "Content-Type: application/json" \
     -d '{"messages":[{"id":"1","type":"TextMessage","content":"list the tables","role":"user"}]}'

echo "Done."
