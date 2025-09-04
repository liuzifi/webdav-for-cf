// MIT License
// 这是一个基于 Cloudflare Workers 和 R2 的 WebDAV 服务器实现。
// R2变量名为：BUCKET
// --- 配置项 ---
const config = {
  // 在这里设置你的 WebDAV 用户名和密码
  // 强烈建议使用强密码
  users: {
    'your_username': 'your_strong_password',
  },
  // 是否允许列出目录内容
  // 对于大多数 WebDAV 客户端是必需的
  allowDirectoryListing: true,
  // 如果你只想将 R2 存储桶中的某个子目录作为 WebDAV 的根目录，请在此处设置
  // 例如 'webdav/'，确保以 '/' 结尾。留空则使用整个存储桶。
  basePath: '', 
};

// --- 主处理逻辑 ---
export default {
  async fetch(request, env, ctx) {
    // 检查 R2 绑定是否存在
    if (!env.BUCKET) {
      return new Response('R2 bucket binding not found. Please bind an R2 bucket as "BUCKET".', { status: 500 });
    }

    // 认证
    const authResponse = checkAuth(request);
    if (authResponse) {
      return authResponse;
    }

    const url = new URL(request.url);
    // 移除路径开头的斜杠，并加上 basePath 前缀
    let key = url.pathname.substring(1);
    if (config.basePath) {
      key = config.basePath + key;
    }

    try {
      switch (request.method) {
        case 'PROPFIND':
          return handlePropfind(request, env.BUCKET, key, url.origin);
        case 'GET':
        case 'HEAD':
          return handleGet(request, env.BUCKET, key);
        case 'PUT':
          return handlePut(request, env.BUCKET, key);
        case 'DELETE':
          return handleDelete(request, env.BUCKET, key);
        case 'MKCOL':
          return handleMkcol(request, env.BUCKET, key);
        case 'COPY':
        case 'MOVE':
          return handleCopyMove(request, env.BUCKET, key);
        case 'OPTIONS':
          return handleOptions();
        default:
          return new Response('Method Not Allowed', { status: 405 });
      }
    } catch (e) {
      return new Response(e.toString(), { status: 500 });
    }
  },
};

// --- 处理器函数 ---

async function handlePropfind(request, bucket, key, origin) {
  const depth = request.headers.get('Depth') || '1';
  
  // 规范化 key，确保以斜杠结尾代表目录
  const isDir = key.endsWith('/') || key === config.basePath.slice(0, -1) || key === '';
  if (isDir && key !== '' && !key.endsWith('/')) {
      key += '/';
  }

  const objects = [];
  if (depth === '0') {
    // 获取单个对象信息
    if (isDir) {
        // 对于目录，我们创建一个虚拟对象
        objects.push({ key: key, size: 0, uploaded: new Date(), isDir: true });
    } else {
        const object = await bucket.head(key);
        if (object) {
            objects.push({ ...object, isDir: false });
        } else {
            return new Response('Not Found', { status: 404 });
        }
    }
  } else { // depth '1' or 'infinity' (我们简化处理为 '1')
    // 列出目录内容
    const list = await bucket.list({ prefix: key, delimiter: '/' });
    
    // 添加当前目录自身
    objects.push({ key: key, size: 0, uploaded: new Date(), isDir: true });

    // 添加文件
    for (const obj of list.objects) {
        objects.push({ ...obj, isDir: false });
    }
    // 添加子目录
    for (const prefix of list.delimitedPrefixes) {
        objects.push({ key: prefix, size: 0, uploaded: new Date(), isDir: true });
    }
  }

  const xml = generatePropfindXml(objects, origin);
  return new Response(xml, {
    status: 207,
    headers: { 'Content-Type': 'application/xml; charset=utf-8' },
  });
}

async function handleGet(request, bucket, key) {
  if (key.endsWith('/')) {
    return new Response('Cannot GET a directory', { status: 400 });
  }

  const object = await bucket.get(key);
  if (object === null) {
    return new Response('Not Found', { status: 404 });
  }

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag );
  
  return new Response(request.method === 'HEAD' ? null : object.body, {
    headers,
  });
}

async function handlePut(request, bucket, key) {
  if (!request.body) {
    return new Response('Request body is required for PUT', { status: 400 });
  }
  await bucket.put(key, request.body, {
      httpMetadata: request.headers,
  } );
  return new Response(null, { status: 201 }); // 201 Created
}

async function handleDelete(request, bucket, key) {
  // 如果是目录，需要递归删除
  if (key.endsWith('/')) {
      const list = await bucket.list({ prefix: key });
      const keysToDelete = list.objects.map(obj => obj.key);
      await bucket.delete(keysToDelete);
  } else {
      await bucket.delete(key);
  }
  return new Response(null, { status: 204 }); // No Content
}

async function handleMkcol(request, bucket, key) {
  // R2 没有真实目录，我们通过创建一个带斜杠的 0 字节对象来模拟
  if (!key.endsWith('/')) {
    key += '/';
  }
  await bucket.put(key, '');
  return new Response(null, { status: 201 }); // Created
}

async function handleCopyMove(request, bucket, sourceKey) {
  const destination = new URL(request.headers.get('Destination')).pathname.substring(1);
  const destKey = config.basePath ? config.basePath + destination : destination;

  // R2 没有原生 copy，需要 get -> put
  const object = await bucket.get(sourceKey);
  if (!object) {
    return new Response('Source Not Found', { status: 404 });
  }
  await bucket.put(destKey, object.body);

  if (request.method === 'MOVE') {
    await bucket.delete(sourceKey);
  }

  return new Response(null, { status: request.method === 'MOVE' ? 204 : 201 });
}

function handleOptions() {
  return new Response(null, {
    status: 200,
    headers: {
      'Allow': 'OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, MKCOL, COPY, MOVE',
      'DAV': '1',
    },
  });
}

// --- 辅助函数 ---

function checkAuth(request) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Basic ')) {
    return new Response('Authorization required', {
      status: 401,
      headers: { 'WWW-Authenticate': 'Basic realm="Cloudflare R2 WebDAV"' },
    });
  }

  const base64Credentials = authHeader.substring(6);
  const credentials = atob(base64Credentials);
  const [username, password] = credentials.split(':');

  if (config.users[username] !== password) {
    return new Response('Invalid credentials', { status: 403 });
  }

  // 认证成功，返回 null
  return null;
}

function generatePropfindXml(objects, origin) {
  let responses = '';
  for (const obj of objects) {
    // 从完整 key 中移除 basePath 前缀，以构建正确的 href
    const hrefPath = config.basePath ? obj.key.replace(config.basePath, '') : obj.key;
    const href = `${origin}/${hrefPath}`;
    const lastModified = new Date(obj.uploaded).toUTCString();
    const isCollection = obj.isDir || obj.key.endsWith('/');
    
    responses += `
    <D:response>
      <D:href>${href}</D:href>
      <D:propstat>
        <D:prop>
          <D:getlastmodified>${lastModified}</D:getlastmodified>
          <D:getcontentlength>${isCollection ? 0 : obj.size}</D:getcontentlength>
          <D:resourcetype>${isCollection ? '<D:collection/>' : ''}</D:resourcetype>
          ${obj.httpEtag ? `<D:getetag>${obj.httpEtag}</D:getetag>` : ''}
        </D:prop>
        <D:status>HTTP/1.1 200 OK</D:status>
      </D:propstat>
    </D:response>`;
  }

  return `<?xml version="1.0" encoding="utf-8" ?>
<D:multistatus xmlns:D="DAV:">
  ${responses}
</D:multistatus>`;
}

