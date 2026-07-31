p = 'AGENTS.md'
with open(p, 'rb') as f:
    data = f.read()
print('has CRLF:', b'\r\n' in data)
print('has LF only:', b'\n' in data and b'\r\n' not in data)
i = data.find('Hidden reasoning uses'.encode('utf-8'))
print('repr:', repr(data[i-15:i+100]))
