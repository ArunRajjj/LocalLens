import ollama

response = ollama.chat(
    model="qwen2.5vl:3b",
    messages=[
        {
            "role": "user",
            "content": "Describe this image. Tell me what you can see.",
            "images": ["test.png"]
        }
    ]
)

print(response["message"]["content"])