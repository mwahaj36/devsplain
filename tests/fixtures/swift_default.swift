
import Foundation

public enum NetworkError: Error {
    case invalidURL
    case requestFailed(Int)
    case decodingFailed
}

public struct User: Codable, Identifiable {
    public let id: Int
    public let name: String
    public let email: String
}

public class APIClient {
    private let baseURL: String
    private let session: URLSession
    public init(baseURL: String, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.session = session
    }
    public func fetchUsers(completion: @escaping (Result<[User], NetworkError>) -> Void) {
        guard let url = URL(string: "\(baseURL)/users") else {
            completion(.failure(.invalidURL))
            return
        }
        let task = session.dataTask(with: url) { data, response, error in
            if let httpResponse = response as? HTTPURLResponse, !(200...299).contains(httpResponse.statusCode) {
                completion(.failure(.requestFailed(httpResponse.statusCode)))
                return
            }
            guard let data = data else {
                completion(.failure(.decodingFailed))
                return
            }
            do {
                let decoder = JSONDecoder()
                let users = try decoder.decode([User].self, from: data)
                completion(.success(users))
            } catch {
                completion(.failure(.decodingFailed))
            }
        }
        task.resume()
    }
}
